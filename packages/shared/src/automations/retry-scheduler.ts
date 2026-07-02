/**
 * RetryScheduler - 失败 webhook 的持久化延迟重试队列
 *
 * 当 webhook 立即重试（秒级）全部失败且仍是瞬态错误时，会被追加到 JSONL 队列文件。
 * 调度器每分钟检查一次队列，按递增间隔重试：
 *   - 第 1 次延迟：5 分钟
 *   - 第 2 次延迟：30 分钟
 *   - 第 3 次延迟：1 小时
 *
 * 所有延迟重试仍失败则丢弃，并写入最终历史记录。队列条目在应用重启后仍然保留。
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '../utils/debug.ts';
import { executeWebhookRequest, createWebhookHistoryEntry } from './webhook-utils.ts';
import { AUTOMATIONS_RETRY_QUEUE_FILE } from './constants.ts';
import { appendAutomationHistoryEntry } from './history-store.ts';
import type { WebhookAction, WebhookActionResult } from './types.ts';

const log = createLogger('retry-scheduler');

// 延迟重试间隔：5 分钟、30 分钟、1 小时
const DEFERRED_DELAYS_MS = [
  5 * 60_000,    // 5 分钟
  30 * 60_000,   // 30 分钟
  60 * 60_000,   // 1 小时
];

const MAX_DEFERRED_ATTEMPTS = DEFERRED_DELAYS_MS.length;

/** 队列扫描间隔 */
const TICK_INTERVAL_MS = 60_000; // 1 分钟

// ============================================================================
// 队列条目
// ============================================================================

export interface RetryQueueEntry {
  /** 唯一条目 ID */
  id: string;
  /** Matcher ID，用于历史记录关联 */
  matcherId: string;
  /** 已展开环境变量的 webhook action（重试时无需原始事件环境） */
  action: WebhookAction;
  /** 已展开的 URL，用于安全日志 */
  expandedUrl: string;
  /** 已经执行过的延迟重试次数（0 表示第一次延迟重试尚未执行） */
  deferredAttempt: number;
  /** 下次重试时间戳 */
  nextRetryAt: number;
  /** 条目创建时间 */
  createdAt: number;
  /** 最近一次错误信息 */
  lastError?: string;
}

// ============================================================================
// RetryScheduler（重试调度器）
// ============================================================================

export interface RetrySchedulerOptions {
  workspaceRootPath: string;
}

export class RetryScheduler {
  private readonly workspaceRootPath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(options: RetrySchedulerOptions) {
    this.workspaceRootPath = options.workspaceRootPath;
  }

  /**
   * 启动调度器。每隔 1 分钟检查一次队列。
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    log.debug('[RetryScheduler] Started');
    // 启动后 5 秒先跑一次初始扫描，不阻塞启动流程
    setTimeout(() => this.tick(), 5_000);
  }

  /**
   * 停止调度器并清理定时器。
   */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.debug('[RetryScheduler] Disposed');
  }

  /**
   * 把失败的 webhook 加入延迟重试队列。
   * 由 WebhookHandler 在立即重试耗尽后调用。
   */
  async enqueue(
    matcherId: string,
    action: WebhookAction,
    expandedUrl: string,
    lastError?: string,
  ): Promise<void> {
    const entry: RetryQueueEntry = {
      id: `${matcherId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      matcherId,
      action,
      expandedUrl,
      deferredAttempt: 0,
      nextRetryAt: Date.now() + DEFERRED_DELAYS_MS[0]!,
      createdAt: Date.now(),
      lastError,
    };

    const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);
    await appendFile(queuePath, JSON.stringify(entry) + '\n', 'utf-8');
    log.debug(`[RetryScheduler] Enqueued ${entry.id} — next retry in ${DEFERRED_DELAYS_MS[0]! / 60_000}m`);
  }

  /**
   * 处理队列：读取条目，重试到期的，重写剩余队列。
   */
  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);

      // 读取队列文件
      let raw: string;
      try {
        raw = await readFile(queuePath, 'utf-8');
      } catch {
        // 没有队列文件就什么都不做
        return;
      }

      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return;

      const entries: RetryQueueEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as RetryQueueEntry);
        } catch {
          // 跳过损坏行
        }
      }

      if (entries.length === 0) return;

      const now = Date.now();
      const remaining: RetryQueueEntry[] = [];

      for (const entry of entries) {
        if (entry.nextRetryAt > now) {
          // 时间未到，继续保留在队列
          remaining.push(entry);
          continue;
        }

        // 执行重试
        log.debug(`[RetryScheduler] Retrying ${entry.id} (deferred attempt ${entry.deferredAttempt + 1}/${MAX_DEFERRED_ATTEMPTS})`);
        let result: WebhookActionResult;
        try {
          result = await executeWebhookRequest(entry.action, { timeoutMs: 30_000 });
        } catch (err) {
          result = {
            type: 'webhook',
            url: entry.expandedUrl,
            statusCode: 0,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }

        if (result.success) {
          // 成功：写历史并从队列删除
          log.debug(`[RetryScheduler] ${entry.id} succeeded on deferred attempt ${entry.deferredAttempt + 1}`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: true,
            method: entry.action.method,
            url: entry.expandedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          // 不加入 remaining，即从队列删除
        } else if (entry.deferredAttempt + 1 >= MAX_DEFERRED_ATTEMPTS) {
          // 最终尝试失败：写永久失败历史
          log.debug(`[RetryScheduler] ${entry.id} permanently failed after ${MAX_DEFERRED_ATTEMPTS} deferred attempts`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: false,
            method: entry.action.method,
            url: entry.expandedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
            error: result.error ?? 'Unknown error',
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          // 不加入 remaining
        } else {
          // 还可重试：安排下一次延迟重试
          const nextDelay = DEFERRED_DELAYS_MS[entry.deferredAttempt + 1]!;
          remaining.push({
            ...entry,
            deferredAttempt: entry.deferredAttempt + 1,
            nextRetryAt: Date.now() + nextDelay,
            lastError: result.error,
          });
          log.debug(`[RetryScheduler] ${entry.id} failed — next retry in ${nextDelay / 60_000}m`);
        }
      }

      // 用剩余条目重写队列文件
      if (remaining.length === 0) {
        await writeFile(queuePath, '', 'utf-8');
      } else {
        const content = remaining.map(e => JSON.stringify(e)).join('\n') + '\n';
        await writeFile(queuePath, content, 'utf-8');
      }
    } catch (err) {
      log.debug(`[RetryScheduler] Tick error: ${err}`);
    } finally {
      this.processing = false;
    }
  }
}
