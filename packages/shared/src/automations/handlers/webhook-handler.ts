/**
 * WebhookHandler - 处理 App 事件中的 webhook 动作
 *
 * 订阅 App 事件，对匹配的 webhook action 执行 HTTP 请求。
 * 支持方法、请求头、请求体格式配置，以及失败后的延迟重试队列。
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, AutomationsConfigProvider } from './types.ts';
import { APP_EVENTS, type AutomationEvent, type WebhookAction, type WebhookActionResult, type AppEvent } from '../types.ts';
import { matcherMatches, buildWebhookEnv, expandEnvVars } from '../utils.ts';
import { executeWithRetry, redactUrl, isTransientFailure, createWebhookHistoryEntry, expandWebhookAction } from '../webhook-utils.ts';
import { RetryScheduler } from '../retry-scheduler.ts';
import { appendAutomationHistoryEntry } from '../history-store.ts';

const log = createLogger('webhook-handler');

// ============================================================================
// 类型
// ============================================================================

export interface WebhookHandlerOptions {
  /** Workspace ID */
  workspaceId: string;
  /** Workspace 根目录 */
  workspaceRootPath: string;
  /** Webhook 执行结果准备好后的回调 */
  onWebhookResults?: (results: WebhookActionResult[]) => void;
  /** Webhook 执行失败时的回调 */
  onError?: (event: AutomationEvent, error: Error) => void;
}

/** Webhook 动作与触发它的 matcher ID 的配对 */
interface WebhookTask {
  action: WebhookAction;
  matcherId: string;
}

// ============================================================================
// 基于端点的滑动窗口限流器
// ============================================================================

/** 按 URL origin 做滑动窗口限流，防止对同一服务器造成洪峰。 */
class EndpointRateLimiter {
  private windows = new Map<string, number[]>();
  private readonly maxPerMinute: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxPerMinute = 30) {
    this.maxPerMinute = maxPerMinute;
    // 每 5 分钟清理一次过期的 origin 记录
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 120_000;
      for (const [origin, timestamps] of this.windows) {
        if (timestamps.every(t => t < cutoff)) {
          this.windows.delete(origin);
        }
      }
    }, 300_000);
  }

  /** 如果请求被允许返回 true，否则返回 false */
  allow(url: string): boolean {
    const origin = this.getOrigin(url);
    const now = Date.now();
    const windowStart = now - 60_000;

    let timestamps = this.windows.get(origin);
    if (timestamps) {
      timestamps = timestamps.filter(t => t > windowStart);
    } else {
      timestamps = [];
    }

    if (timestamps.length >= this.maxPerMinute) {
      return false;
    }

    timestamps.push(now);
    this.windows.set(origin, timestamps);
    return true;
  }

  private getOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}

// ============================================================================
// WebhookHandler 实现
// ============================================================================

export class WebhookHandler implements AutomationHandler {
  private readonly options: WebhookHandlerOptions;
  private readonly configProvider: AutomationsConfigProvider;
  private readonly rateLimiter = new EndpointRateLimiter(30);
  private readonly retryScheduler: RetryScheduler;
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;

  constructor(options: WebhookHandlerOptions, configProvider: AutomationsConfigProvider) {
    this.options = options;
    this.configProvider = configProvider;
    this.retryScheduler = new RetryScheduler({ workspaceRootPath: options.workspaceRootPath });
  }

  /**
   * 订阅事件总线上的 App 事件，并启动重试调度器。
   */
  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    this.retryScheduler.start();
    log.debug(`[WebhookHandler] Subscribed to event bus`);
  }

  /**
   * 处理事件：执行匹配的 webhook action。
   */
  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    // 只处理 App 事件
    if (!APP_EVENTS.includes(event as AppEvent)) {
      return;
    }

    const matchers = this.configProvider.getMatchersForEvent(event);
    if (matchers.length === 0) return;

    // 收集匹配的 webhook 任务，保留 matcher ID 以便写历史
    const webhookTasks: WebhookTask[] = [];

    for (const matcher of matchers) {
      if (!matcherMatches(matcher, event, payload as unknown as Record<string, unknown>)) continue;

      for (const action of matcher.actions) {
        if (action.type === 'webhook') {
          webhookTasks.push({ action, matcherId: matcher.id ?? 'unknown' });
        }
      }
    }

    if (webhookTasks.length === 0) return;

    log.debug(`[WebhookHandler] Processing ${webhookTasks.length} webhooks for ${event}`);

    // 构建 webhook 专用环境变量：不泄露整个 process.env，只注入 CRAFT_WH_* 用户密钥
    const env = buildWebhookEnv(event, payload);

    // 先展开 URL 再做限流，确保限流基于真实目标地址
    const results: WebhookActionResult[] = new Array(webhookTasks.length);
    const toExecute: Array<{ index: number; task: WebhookTask }> = [];

    for (let i = 0; i < webhookTasks.length; i++) {
      const task = webhookTasks[i]!;
      const resolvedUrl = expandEnvVars(task.action.url, env);

      if (!this.rateLimiter.allow(resolvedUrl)) {
        log.debug(`[WebhookHandler] Rate-limited: ${redactUrl(resolvedUrl)}`);
        results[i] = {
          type: 'webhook',
          url: resolvedUrl,
          statusCode: 0,
          success: false,
          error: 'Rate-limited: too many requests to this endpoint',
          durationMs: 0,
          attempts: 0,
        };
      } else {
        toExecute.push({ index: i, task });
      }
    }

    // 对允许执行的请求并行调用，并开启瞬态失败重试
    if (toExecute.length > 0) {
      const webhookOpts = { env, retry: { maxAttempts: 2 } };
      const outcomes = await Promise.allSettled(
        toExecute.map(({ task }) => executeWithRetry(task.action, webhookOpts))
      );

      for (let j = 0; j < outcomes.length; j++) {
        const outcome = outcomes[j]!;
        const { index, task } = toExecute[j]!;

        if (outcome.status === 'fulfilled') {
          results[index] = outcome.value;
        } else {
          results[index] = {
            type: 'webhook',
            url: task.action.url,
            statusCode: 0,
            success: false,
            error: outcome.reason?.message ?? 'Unknown error',
          };
        }
      }
    }

    // 记录结果、写历史，并把持久失败 enqueue 到延迟重试队列
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const task = webhookTasks[i]!;

      if (!result.success) {
        log.debug(`[WebhookHandler] ${result.url} → ${result.error}`);
      }

      // 写历史条目；失败不抛错，避免影响其他 webhook
      const entry = createWebhookHistoryEntry({
        matcherId: task.matcherId,
        ok: result.success,
        method: task.action.method,
        url: result.url,
        statusCode: result.statusCode,
        durationMs: result.durationMs ?? 0,
        attempts: result.attempts,
        error: result.error,
        responseBody: result.responseBody,
      });
      try {
        await appendAutomationHistoryEntry(this.options.workspaceRootPath, entry);
      } catch (e) {
        log.debug(`[WebhookHandler] Failed to write history: ${e}`);
      }

      // 瞬态失败（5xx / 超时）且已经尝试过立即重试，则进入持久延迟队列
      if (isTransientFailure(result)) {
        if (result.attempts && result.attempts > 1) {
          const expandedAction = expandWebhookAction(task.action, env);
          this.retryScheduler.enqueue(task.matcherId, expandedAction, result.url, result.error)
            .catch(e => log.debug(`[WebhookHandler] Failed to enqueue for deferred retry: ${e}`));
        }
      }
    }

    // 通过回调交付结果
    if (results.length > 0 && this.options.onWebhookResults) {
      log.debug(`[WebhookHandler] Delivering ${results.length} webhook results`);
      this.options.onWebhookResults(results);
    }
  }

  /**
   * 清理资源、取消订阅并停止重试调度器。
   */
  dispose(): void {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;
    this.rateLimiter.dispose();
    this.retryScheduler.dispose();
    log.debug(`[WebhookHandler] Disposed`);
  }
}
