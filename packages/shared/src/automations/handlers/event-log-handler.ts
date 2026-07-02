/**
 * EventLogHandler - 把所有自动化事件记录到 events.jsonl
 *
 * 订阅总线上的所有事件，用于审计和回放。
 * 底层复用已有的 AutomationEventLogger 做缓冲写入。
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, EventLogHandlerOptions } from './types.ts';
import type { AutomationEvent } from '../types.ts';
import { AutomationEventLogger } from '../event-logger.ts';

const log = createLogger('event-log-handler');

// ============================================================================
// EventLogHandler 实现
// ============================================================================

export class EventLogHandler implements AutomationHandler {
  private readonly options: EventLogHandlerOptions;
  private readonly logger: AutomationEventLogger;
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;

  constructor(options: EventLogHandlerOptions) {
    this.options = options;
    this.logger = new AutomationEventLogger(options.workspaceRootPath);

    // 如果调用方关心事件丢失，把回调转发给 logger
    if (options.onEventLost) {
      this.logger.onEventLost = options.onEventLost;
    }
  }

  /**
   * 订阅总线上的所有事件。
   */
  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    log.debug(`[EventLogHandler] Subscribed to event bus, logging to ${this.logger.getLogPath()}`);
  }

  /**
   * 处理事件：把它记录到事件日志。
   */
  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    const startTime = payload.timestamp;
    const durationMs = Date.now() - startTime;

    this.logger.log({
      type: event,
      sessionId: payload.sessionId,
      workspaceId: this.options.workspaceId,
      data: { ...payload },
      results: [], // 执行结果由各 handler 单独记录
      durationMs,
    });

    log.debug(`[EventLogHandler] Logged: ${event}`);
  }

  /**
   * 获取事件日志文件路径。
   */
  getLogPath(): string {
    return this.logger.getLogPath();
  }

  /**
   * 清理资源并取消订阅。
   */
  async dispose(): Promise<void> {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;

    // 刷盘并关闭 logger
    await this.logger.dispose();
    log.debug(`[EventLogHandler] Disposed`);
  }
}
