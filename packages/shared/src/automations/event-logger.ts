/**
 * AutomationEventLogger - 将自动化事件写入 events.jsonl
 *
 * 采用受 CloudEvents 启发的 schema，批量 I/O 以提升性能。
 * 只追加写入，便于审计和后续回放。
 */

import { appendFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ActionExecutionResult } from './types.ts';

// ============================================================================
// 类型定义
// ============================================================================

export interface LoggedAutomationEvent {
  /** 唯一事件 ID（UUID） */
  id: string;
  /** 事件类型，例如 'LabelAdd'、'PermissionModeChange' */
  type: string;
  /** ISO 8601 UTC 时间戳 */
  time: string;
  /** 来源标识 */
  source: string;
  /** 所属会话 ID（如果有） */
  sessionId?: string;
  /** 所属 workspace ID */
  workspaceId?: string;
  /** 事件 payload */
  data: Record<string, unknown>;
  /** 自动化执行结果 */
  results: ActionExecutionResult[];
  /** 总执行耗时（毫秒） */
  durationMs: number;
}

// Omit<T, K> 是 TS 工具类型：从类型 T 中去掉 K 属性，得到输入类型
export type LoggedAutomationEventInput = Omit<LoggedAutomationEvent, 'id' | 'time' | 'source'>;

// ============================================================================
// AutomationEventLogger 类
// ============================================================================

export class AutomationEventLogger {
  private logPath: string;
  private buffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private flushInProgress = false;
  private readonly FLUSH_DELAY_MS = 100;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 100;

  /** 可选回调：当事件在重试后仍然丢失时触发 */
  onEventLost?: (events: string[], error: Error) => void;

  constructor(workspaceRootPath: string) {
    this.logPath = join(workspaceRootPath, 'events.jsonl');
  }

  /**
   * 记录一个事件到事件流。
   * 事件会先进入缓冲区，经过短暂延迟后批量刷盘，以合并高频写入。
   */
  log(event: LoggedAutomationEventInput): void {
    if (this.isDisposed) {
      console.warn('[AutomationEventLogger] Attempted to log after disposal');
      return;
    }

    // 用展开运算符 ...event 把输入字段合并到默认字段中
    const entry: LoggedAutomationEvent = {
      id: randomUUID(),
      time: new Date().toISOString(),
      source: 'craft-agent/automations',
      ...event,
    };
    this.buffer.push(JSON.stringify(entry));
    this.scheduleFlush();
  }

  /**
   * 获取事件日志文件的完整路径。
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * 如果当前没有定时刷新任务，则安排一次延迟刷新。
   */
  private scheduleFlush(): void {
    if (!this.flushTimer && !this.isDisposed) {
      this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_DELAY_MS);
    }
  }

  /**
   * 将缓冲区事件刷盘，失败时自动重试。
   * 通过原子交换缓冲区避免并发冲突。
   */
  private async flush(): Promise<void> {
    this.flushTimer = null;

    // 防止并发刷新
    if (this.flushInProgress) {
      this.scheduleFlush();
      return;
    }

    if (this.buffer.length === 0) return;

    this.flushInProgress = true;

    // 原子交换：把当前缓冲区“拿走”，再开一个新的空缓冲区
    const toFlush = this.buffer;
    this.buffer = [];

    const lines = toFlush.join('\n') + '\n';
    let lastError: Error | null = null;

    // 指数退避重试
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        await appendFile(this.logPath, lines, 'utf-8');
        this.flushInProgress = false;
        return; // 成功
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[AutomationEventLogger] Write failed (attempt ${attempt + 1}/${this.MAX_RETRIES}):`, error);

        if (attempt < this.MAX_RETRIES - 1) {
          // 重试前等待，指数退避
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * Math.pow(2, attempt)));
        }
      }
    }

    // 全部重试失败：如果有回调则通知调用方，否则把事件塞回缓冲区头部等待下次
    this.flushInProgress = false;

    if (this.onEventLost) {
      this.onEventLost(toFlush, lastError!);
    } else {
      this.buffer = [...toFlush, ...this.buffer];
      console.error(`[AutomationEventLogger] Events re-queued after ${this.MAX_RETRIES} failed attempts`);
    }
  }

  /**
   * 关闭 logger，立即刷新剩余事件。
   * 通常在应用关闭时调用。
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * dispose logger：停止定时器、刷盘并阻止后续写入。
   * close() 的别名，并额外清空残留缓冲区。
   */
  async dispose(): Promise<void> {
    this.isDisposed = true;
    await this.close();
    this.buffer = []; // 清空残留事件
  }
}
