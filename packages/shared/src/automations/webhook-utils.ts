/**
 * Webhook 执行工具
 *
 * 生产环境 WebhookHandler 和 RPC 测试 handler 共用的 HTTP 执行逻辑。
 * 集中处理超时、响应体消费、请求构建、环境变量展开和重试，避免两条路径分叉。
 */

import type { WebhookAction, WebhookActionResult } from './types.ts';
import { expandEnvVars } from './utils.ts';
import { DEFAULT_WEBHOOK_METHOD, HISTORY_FIELD_MAX_LENGTH } from './constants.ts';

/**
 * 对 URL 做脱敏，便于安全日志输出。
 * Webhook URL 可能包含密钥（如 Slack webhook 路径），只保留 scheme + host，路径太长则截断。
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.length > 20) {
      return `${parsed.origin}${parsed.pathname.slice(0, 15)}...`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 30) + '...';
  }
}

/**
 * 创建一条 webhook 历史记录，用于追加到历史 JSONL 文件。
 */
export function createWebhookHistoryEntry(opts: {
  matcherId: string;
  ok: boolean;
  method?: string;
  url: string;
  statusCode: number;
  durationMs: number;
  attempts?: number;
  error?: string;
  responseBody?: string;
}): Record<string, unknown> {
  return {
    id: opts.matcherId,
    ts: Date.now(),
    ok: opts.ok,
    webhook: {
      method: opts.method ?? DEFAULT_WEBHOOK_METHOD,
      url: redactUrl(opts.url),
      statusCode: opts.statusCode,
      durationMs: opts.durationMs,
      ...(opts.attempts && opts.attempts > 1 ? { attempts: opts.attempts } : {}),
      ...(opts.error ? { error: opts.error.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
      ...(opts.responseBody ? { responseBody: opts.responseBody.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
    },
  };
}

/**
 * 创建一条 prompt 动作的历史记录，用于追加到历史 JSONL 文件。
 */
export function createPromptHistoryEntry(opts: {
  matcherId: string;
  ok: boolean;
  sessionId?: string;
  prompt?: string;
  error?: string;
}): Record<string, unknown> {
  return {
    id: opts.matcherId,
    ts: Date.now(),
    ok: opts.ok,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.prompt ? { prompt: opts.prompt.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
    ...(opts.error ? { error: opts.error.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
  };
}

/**
 * 返回一个所有可展开字符串字段都已解析的 WebhookAction 副本。
 * 在入队持久重试前调用，这样重试调度器不需要原始事件环境也能执行。
 */
export function expandWebhookAction(action: WebhookAction, env: Record<string, string>): WebhookAction {
  const expanded: WebhookAction = {
    ...action,
    url: expandEnvVars(action.url, env),
  };

  if (action.headers) {
    expanded.headers = {};
    for (const [key, value] of Object.entries(action.headers)) {
      expanded.headers[key] = expandEnvVars(value, env);
    }
  }

  if (typeof action.body === 'string') {
    expanded.body = expandEnvVars(action.body, env);
  } else if (action.body !== undefined && typeof action.body === 'object' && action.body !== null) {
    expanded.body = JSON.parse(expandEnvVars(JSON.stringify(action.body), env));
  }

  if (action.auth) {
    if (action.auth.type === 'basic') {
      expanded.auth = {
        type: 'basic',
        username: expandEnvVars(action.auth.username, env),
        password: expandEnvVars(action.auth.password, env),
      };
    } else if (action.auth.type === 'bearer') {
      expanded.auth = {
        type: 'bearer',
        token: expandEnvVars(action.auth.token, env),
      };
    }
  }

  return expanded;
}

/** 默认 fetch 超时（30 秒，与 Claude Code 的 HTTP hook 默认一致） */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RetryConfig {
  /** 最大重试次数（默认 0，表示不重试） */
  maxAttempts: number;
  /** 初始延迟（毫秒，默认 1000），每次翻倍 */
  initialDelayMs?: number;
  /** 延迟上限（毫秒，默认 10000） */
  maxDelayMs?: number;
}

export interface ExecuteWebhookOptions {
  /** 超时（毫秒，默认 30000） */
  timeoutMs?: number;
  /** 用于 $VAR 展开的环境变量。undefined 表示不做展开（测试用 raw 模式） */
  env?: Record<string, string>;
  /** 瞬态失败重试配置，默认禁用 */
  retry?: RetryConfig;
}

/**
 * 执行一次 webhook HTTP 请求。
 *
 * 处理：请求构建、环境变量展开、AbortController 超时、
 * 响应体消费（防止内存泄漏）、错误包装。
 * 结果包含 durationMs 便于观测。
 *
 * @param action - automations 配置中的 webhook 动作定义
 * @param options - 执行选项（超时、展开用的环境变量）
 * @returns 包含状态、成功标志、耗时和错误信息的 WebhookActionResult
 */
export async function executeWebhookRequest(
  action: WebhookAction,
  options?: ExecuteWebhookOptions,
): Promise<WebhookActionResult> {
  const env = options?.env;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const method = action.method ?? DEFAULT_WEBHOOK_METHOD;
  const url = env ? expandEnvVars(action.url, env) : action.url;

  // 展开后校验 URL scheme
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        type: 'webhook', url, statusCode: 0, success: false,
        error: `Invalid URL scheme "${parsed.protocol}" — only http and https are allowed`,
        durationMs: 0,
      };
    }
  } catch {
    return {
      type: 'webhook', url, statusCode: 0, success: false,
      error: `Invalid URL after variable expansion: "${url.slice(0, 50)}"`,
      durationMs: 0,
    };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 构建请求头
    const headers: Record<string, string> = {};

    // 先应用 auth 简写，再应用自定义 headers，这样 headers 可以覆盖 auth
    if (action.auth) {
      if (action.auth.type === 'basic') {
        const user = env ? expandEnvVars(action.auth.username, env) : action.auth.username;
        const pass = env ? expandEnvVars(action.auth.password, env) : action.auth.password;
        headers['Authorization'] = `Basic ${btoa(`${user}:${pass}`)}`;
      } else if (action.auth.type === 'bearer') {
        const token = env ? expandEnvVars(action.auth.token, env) : action.auth.token;
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    if (action.headers) {
      for (const [key, value] of Object.entries(action.headers)) {
        headers[key] = env ? expandEnvVars(value, env) : value;
      }
    }

    // 构建请求体
    let requestBody: string | undefined;
    if (method !== 'GET' && action.body !== undefined) {
      const bodyFormat = action.bodyFormat ?? 'json';

      if (bodyFormat === 'json') {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        if (typeof action.body === 'string') {
          requestBody = env ? expandEnvVars(action.body, env) : action.body;
        } else {
          const raw = JSON.stringify(action.body);
          requestBody = env ? expandEnvVars(raw, env) : raw;
        }
      } else if (bodyFormat === 'form') {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        if (typeof action.body === 'object' && action.body !== null) {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(action.body as Record<string, unknown>)) {
            const val = String(v ?? '');
            params.append(k, env ? expandEnvVars(val, env) : val);
          }
          requestBody = params.toString();
        } else {
          const raw = String(action.body);
          requestBody = env ? expandEnvVars(raw, env) : raw;
        }
      } else {
        // raw 格式
        const raw = String(action.body);
        requestBody = env ? expandEnvVars(raw, env) : raw;
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    const success = response.status >= 200 && response.status < 300;

    // 消费响应体以释放 TCP 连接，防止内存泄漏。
    // 需要时截取响应体（最多 4KB）。
    const MAX_RESPONSE_SIZE = 4096;
    let responseBody: string | undefined;
    try {
      const text = await response.text();
      if (action.captureResponse) {
        responseBody = text.length > MAX_RESPONSE_SIZE
          ? text.slice(0, MAX_RESPONSE_SIZE) + '...(truncated)'
          : text;
      }
    } catch {
      // 响应体消费失败不是致命错误
    }

    return {
      type: 'webhook',
      url,
      statusCode: response.status,
      success,
      error: success ? undefined : `HTTP ${response.status} ${response.statusText}`,
      durationMs: Date.now() - start,
      ...(responseBody !== undefined ? { responseBody } : {}),
    };
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    const error = isTimeout
      ? `Request timed out after ${timeoutMs}ms`
      : err instanceof Error ? err.message : 'Unknown error';

    return {
      type: 'webhook',
      url,
      statusCode: 0,
      success: false,
      error,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 判断 webhook 结果是否属于值得重试的瞬态失败。
 * - 5xx 服务端错误：通常可重试
 * - 超时 / 连接错误（statusCode 0）：通常可重试
 * - 4xx 客户端错误：不重试（请求本身有问题）
 * - 2xx 成功：当然不重试
 */
export function isTransientFailure(result: WebhookActionResult): boolean {
  if (result.success) return false;
  // 4xx = 客户端错误，不可重试
  if (result.statusCode >= 400 && result.statusCode < 500) return false;
  // 5xx 或 0（超时/连接错误）= 可重试
  return true;
}

/**
 * 执行 webhook 请求，支持对瞬态失败做可选重试。
 *
 * 在 executeWebhookRequest 基础上包装指数退避 + 抖动。
 * 如果未配置重试（或 maxAttempts=0），行为与 executeWebhookRequest 完全一致。
 *
 * @param action - webhook 动作定义
 * @param options - 包含重试配置的执行选项
 * @returns 带 attempts 计数和总耗时的 WebhookActionResult
 */
export async function executeWithRetry(
  action: WebhookAction,
  options?: ExecuteWebhookOptions,
): Promise<WebhookActionResult> {
  const maxAttempts = options?.retry?.maxAttempts ?? 0;

  // 未配置重试 - 单次尝试
  if (maxAttempts <= 0) {
    const result = await executeWebhookRequest(action, options);
    return { ...result, attempts: 1 };
  }

  const initialDelay = options?.retry?.initialDelayMs ?? 1000;
  const maxDelay = options?.retry?.maxDelayMs ?? 10_000;
  const totalStart = Date.now();

  let lastResult: WebhookActionResult | undefined;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    lastResult = await executeWebhookRequest(action, options);

    // 成功或非瞬态失败 - 立即返回
    if (!isTransientFailure(lastResult)) {
      return {
        ...lastResult,
        attempts: attempt + 1,
        durationMs: Date.now() - totalStart,
      };
    }

    // 最后一次尝试 - 不再延迟，直接返回
    if (attempt === maxAttempts) break;

    // 指数退避 + 抖动（±10%）
    const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
    const jitter = delay * 0.1 * (Math.random() * 2 - 1); // ±10%
    await new Promise(r => setTimeout(r, delay + jitter));
  }

  return {
    ...lastResult!,
    attempts: maxAttempts + 1,
    durationMs: Date.now() - totalStart,
  };
}
