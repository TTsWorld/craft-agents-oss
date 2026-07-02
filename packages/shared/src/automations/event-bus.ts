/**
 * WorkspaceEventBus - 自动化系统的类型安全事件总线
 *
 * 每个 workspace 拥有独立的事件总线实例，实现事件生产者与消费者解耦：
 * - 生产者：ConfigWatcher、SchedulerService
 * - 消费者：CommandHandler、PromptHandler、EventLogHandler
 *
 * 相比之前的全局回调方式：
 * - 无全局状态，每个 workspace 独立
 * - 类型安全，payload 有类型约束
 * - handler 可动态增删
 * - 可单独测试
 */

import { createLogger } from '../utils/debug.ts';
import type { AppEvent, AgentEvent, AutomationEvent } from './types.ts';

const log = createLogger('event-bus');

// ============================================================================
// 事件 Payload 类型
// ============================================================================

/** 所有事件 payload 的公共字段 */
export interface BaseEventPayload {
  sessionId?: string;
  sessionName?: string;
  workspaceId: string;
  timestamp: number;
  labels?: string[];
}

/** Label 相关事件 payload */
export interface LabelEventPayload extends BaseEventPayload {
  label: string;
}

/** 权限模式变更 payload */
export interface PermissionModeChangePayload extends BaseEventPayload {
  oldMode: string;
  newMode: string;
}

/** 标记变更 payload */
export interface FlagChangePayload extends BaseEventPayload {
  isFlagged: boolean;
}

/** 会话状态变更 payload */
export interface SessionStatusChangePayload extends BaseEventPayload {
  oldState: string;
  newState: string;
}

/** SchedulerTick payload */
export interface SchedulerTickPayload extends BaseEventPayload {
  localTime: string;
  utcTime: string;
}

/** Label 配置变更 payload */
export interface LabelConfigChangePayload extends BaseEventPayload {
  // 无额外字段，仅作为配置变更信号
}

/** Agent 事件的通用 payload */
export interface GenericEventPayload extends BaseEventPayload {
  data: Record<string, unknown>;
}

// ============================================================================
// 事件到 Payload 的映射
// ============================================================================

/**
 * 把事件类型映射到对应的 payload 类型，保证类型安全。
 * 类似 Go 里的 map[string]Payload，但 TS 在编译期就能检查类型。
 */
export interface EventPayloadMap {
  // App 事件
  LabelAdd: LabelEventPayload;
  LabelRemove: LabelEventPayload;
  LabelConfigChange: LabelConfigChangePayload;
  PermissionModeChange: PermissionModeChangePayload;
  FlagChange: FlagChangePayload;
  SessionStatusChange: SessionStatusChangePayload;
  SchedulerTick: SchedulerTickPayload;

  // Agent 事件统一使用通用 payload
  PreToolUse: GenericEventPayload;
  PostToolUse: GenericEventPayload;
  PostToolUseFailure: GenericEventPayload;
  Notification: GenericEventPayload;
  UserPromptSubmit: GenericEventPayload;
  SessionStart: GenericEventPayload;
  SessionEnd: GenericEventPayload;
  Stop: GenericEventPayload;
  SubagentStart: GenericEventPayload;
  SubagentStop: GenericEventPayload;
  PreCompact: GenericEventPayload;
  PermissionRequest: GenericEventPayload;
  Setup: GenericEventPayload;
}

// ============================================================================
// Handler 类型
// ============================================================================

/**
 * 处理特定事件的 handler 类型。
 * T extends AutomationEvent 是泛型约束，表示 T 只能是 AutomationEvent 中的某个事件名。
 */
export type EventHandler<T extends AutomationEvent> = (
  payload: EventPayloadMap[T]
) => void | Promise<void>;

/**
 * 监听所有事件的 handler 类型。
 */
export type AnyEventHandler = (
  event: AutomationEvent,
  payload: BaseEventPayload
) => void | Promise<void>;

// ============================================================================
// 限流
// ============================================================================

interface RateWindow {
  count: number;
  windowStart: number;
}

const DEFAULT_RATE_LIMIT = 10;
const SCHEDULER_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000; // 1 分钟

function getRateLimit(event: AutomationEvent): number {
  return event === 'SchedulerTick' ? SCHEDULER_RATE_LIMIT : DEFAULT_RATE_LIMIT;
}

// ============================================================================
// EventBus 接口
// ============================================================================

export interface EventBus {
  /** 触发一个事件，通知所有已注册 handler */
  emit<T extends AutomationEvent>(event: T, payload: EventPayloadMap[T]): Promise<void>;

  /** 为指定事件注册 handler */
  on<T extends AutomationEvent>(event: T, handler: EventHandler<T>): void;

  /** 为指定事件注销 handler */
  off<T extends AutomationEvent>(event: T, handler: EventHandler<T>): void;

  /** 注册一个监听所有事件的 handler（适合日志、监控） */
  onAny(handler: AnyEventHandler): void;

  /** 注销监听所有事件的 handler */
  offAny(handler: AnyEventHandler): void;

  /** 清理所有 handler */
  dispose(): void;
}

// ============================================================================
// WorkspaceEventBus 实现
// ============================================================================

export class WorkspaceEventBus implements EventBus {
  private readonly workspaceId: string;
  private readonly handlers: Map<AutomationEvent, Set<EventHandler<AutomationEvent>>> = new Map();
  private readonly anyHandlers: Set<AnyEventHandler> = new Set();
  private readonly rateCounts: Map<AutomationEvent, RateWindow> = new Map();
  private disposed = false;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
    log.debug(`[EventBus] Created for workspace: ${workspaceId}`);
  }

  /**
   * 触发事件，并行调用所有注册的 handler，错误会被捕获并记录。
   */
  async emit<T extends AutomationEvent>(event: T, payload: EventPayloadMap[T]): Promise<void> {
    if (this.disposed) {
      log.warn(`[EventBus] Attempted to emit after disposal: ${event}`);
      return;
    }

    // 限流：防止同步/异步死循环导致事件风暴
    const now = Date.now();
    const rateWindow = this.rateCounts.get(event) ?? { count: 0, windowStart: now };
    if (now - rateWindow.windowStart >= RATE_WINDOW_MS) {
      rateWindow.count = 0;
      rateWindow.windowStart = now;
    }
    const limit = getRateLimit(event);
    if (rateWindow.count >= limit) {
      log.warn(
        `[EventBus] Rate limit: ${event} fired ${rateWindow.count} times in ${Math.round((now - rateWindow.windowStart) / 1000)}s (limit: ${limit}/min), dropping`
      );
      return;
    }
    rateWindow.count++;
    this.rateCounts.set(event, rateWindow);

    log.debug(`[EventBus] Emitting: ${event}`);

    // 收集要调用的 handler
    const eventHandlers = this.handlers.get(event) ?? new Set();
    const anyHandlersCopy = new Set(this.anyHandlers);

    // 调用事件专属 handler
    const eventPromises = Array.from(eventHandlers).map(async (handler) => {
      try {
        await handler(payload);
      } catch (error) {
        log.error(`[EventBus] Handler error for ${event}:`, error);
      }
    });

    // 调用全事件 handler
    const anyPromises = Array.from(anyHandlersCopy).map(async (handler) => {
      try {
        await handler(event, payload as BaseEventPayload);
      } catch (error) {
        log.error(`[EventBus] Any-handler error for ${event}:`, error);
      }
    });

    // 等待所有 handler 完成
    await Promise.all([...eventPromises, ...anyPromises]);

    log.debug(`[EventBus] Emitted: ${event} (${eventHandlers.size} handlers, ${anyHandlersCopy.size} any-handlers)`);
  }

  /**
   * 为指定事件注册 handler。
   */
  on<T extends AutomationEvent>(event: T, handler: EventHandler<T>): void {
    if (this.disposed) {
      log.warn(`[EventBus] Attempted to register handler after disposal: ${event}`);
      return;
    }

    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<AutomationEvent>);
    log.debug(`[EventBus] Registered handler for: ${event}`);
  }

  /**
   * 为指定事件注销 handler。
   */
  off<T extends AutomationEvent>(event: T, handler: EventHandler<T>): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.delete(handler as EventHandler<AutomationEvent>);
      log.debug(`[EventBus] Unregistered handler for: ${event}`);
    }
  }

  /**
   * 注册一个监听所有事件的 handler。
   * 适合日志、指标、调试。
   */
  onAny(handler: AnyEventHandler): void {
    if (this.disposed) {
      log.warn(`[EventBus] Attempted to register any-handler after disposal`);
      return;
    }

    this.anyHandlers.add(handler);
    log.debug(`[EventBus] Registered any-handler`);
  }

  /**
   * 注销监听所有事件的 handler。
   */
  offAny(handler: AnyEventHandler): void {
    this.anyHandlers.delete(handler);
    log.debug(`[EventBus] Unregistered any-handler`);
  }

  /**
   * 清理所有 handler 并标记为已 dispose。
   */
  dispose(): void {
    if (this.disposed) return;

    log.debug(`[EventBus] Disposing for workspace: ${this.workspaceId}`);
    this.handlers.clear();
    this.anyHandlers.clear();
    this.rateCounts.clear();
    this.disposed = true;
  }

  /**
   * 检查总线是否已 dispose。
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 获取总线所属的 workspace ID。
   */
  getWorkspaceId(): string {
    return this.workspaceId;
  }

  /**
   * 获取 handler 数量，用于调试。
   */
  getHandlerCount(event?: AutomationEvent): number {
    if (event) {
      return this.handlers.get(event)?.size ?? 0;
    }
    let total = this.anyHandlers.size;
    for (const handlers of this.handlers.values()) {
      total += handlers.size;
    }
    return total;
  }
}
