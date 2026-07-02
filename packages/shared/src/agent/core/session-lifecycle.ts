/**
 * 【文件级】SessionLifecycle —— Agent 会话生命周期的共享类型与工具
 *
 * Agent 的一次“对话”称为一个 session，包含多轮 message。本模块抽象出
 * session 的状态跟踪（活跃？已收几条消息？）、中止原因分类（用户主动停 / 提交方案 /
 * 触发鉴权 / 重定向 / source 激活 / 超时 / 内部错误）和清理模式。
 *
 * 真正的中止实现是 provider-specific 的，本模块只提供共享类型与工具方法：
 *   - ClaudeAgent 用 AbortController 配合 Claude SDK 中止
 *   - PiAgent 通过 JSONL 信号通知 pi-agent-server 子进程
 *
 * Agent 概念速查：
 *   - session：一次连续对话，类似 Go 里一次 HTTP 请求-响应的“长连接”。
 *   - message / turn：用户发一条 → agent 回一条，称为一轮。
 *   - abort：取消当前正在进行的 LLM 调用或工具执行。
 */

// ============================================================
// 类型定义区
// ============================================================

/**
 * 中止 agent 执行的原因。
 * 用于把“用户主动停”和“内部触发中止”区分开，便于 UI 决定是否清空会话状态。
 *
 * TS 的 enum 是“具名常量集合”，本质是 string→string 的双向映射，
 * 这里用字符串枚举（= 'user_stop'）让序列化后的值可读。
 */
export enum AbortReason {
  /** 用户点了停止按钮 */
  UserStop = 'user_stop',

  /** Agent 提交了方案，正在等待审核 */
  PlanSubmitted = 'plan_submitted',

  /** 触发了鉴权请求（OAuth、凭证输入弹窗） */
  AuthRequest = 'auth_request',

  /** 处理中又来了新消息（静默重定向到新消息） */
  Redirect = 'redirect',

  /** 请求激活 source——需要带上新工具重启 */
  SourceActivated = 'source_activated',

  /** 会话超时 */
  Timeout = 'timeout',

  /** 需要中止的内部错误 */
  InternalError = 'internal_error',
}

/**
 * Agent 生命周期内的会话状态快照。
 * 字段都用 TS 接口描述，interface 在编译期擦除，不产生运行时对象（对比 Go 的 struct）。
 */
export interface SessionState {
  /** 会话唯一 ID */
  sessionId: string;

  /** 当前会话是否活跃（未 deactivate / 未 dispose） */
  isActive: boolean;

  /** 本会话累计的 message/turn 数 */
  messageCount: number;

  /** 会话开始的 Unix 毫秒时间戳 */
  startedAt: number;

  /** 最后一次活动的时间戳（用于空闲检测） */
  lastActivityAt: number;

  /** 是否已收到过任何 assistant 输出内容（决定 abort 时是否清空会话） */
  hasReceivedContent: boolean;
}

/**
 * SessionLifecycleManager 的配置。
 * onStateChange / onDebug 都是可选回调（?: 表示可选属性），不传也行。
 */
export interface SessionLifecycleConfig {
  /** 会话 ID */
  sessionId: string;

  /** 状态变更时的回调（每次 messageCount / isActive 变化都会触发） */
  onStateChange?: (state: SessionState) => void;

  /** 调试日志回调 */
  onDebug?: (message: string) => void;
}

// ============================================================
// SessionLifecycleManager 类
// ============================================================

/**
 * 会话生命周期管理器。
 *
 * 负责：
 *   - 会话状态跟踪（活跃、消息数、时间戳）
 *   - 中止原因的存取（set / consume / get）
 *   - 会话清理辅助判断
 *
 * 每个 agent 实例持有一个 SessionLifecycleManager。
 */
export class SessionLifecycleManager {
  // private 修饰符表示类私有，TS 编译期检查（运行时不强制，与 Go 的小写首字母字段类似）。
  private state: SessionState;
  // AbortReason | null 是联合类型，表示“要么是某个枚举值，要么是 null”。
  private currentAbortReason: AbortReason | null = null;
  private config: SessionLifecycleConfig;

  constructor(config: SessionLifecycleConfig) {
    this.config = config;
    this.state = {
      sessionId: config.sessionId,
      isActive: true,
      messageCount: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      hasReceivedContent: false,
    };
  }

  /**
   * 取当前会话状态的拷贝。
   * 返回浅拷贝（{ ...this.state }）防止外部直接改内部状态——TS 里对象是引用传递。
   */
  getState(): SessionState {
    return { ...this.state };
  }

  /** 取会话 ID。 */
  getSessionId(): string {
    return this.state.sessionId;
  }

  /** 判断是不是会话的第一条消息。 */
  isFirstMessage(): boolean {
    return this.state.messageCount === 0;
  }

  /** 记录一轮 message 已开始（仅更新时间戳，不增计数）。 */
  recordMessageStart(): void {
    this.debug(`Message ${this.state.messageCount + 1} started`);
    this.state.lastActivityAt = Date.now();
  }

  /** 记录一轮 message 完成：计数 +1，更新时间戳，通知监听者。 */
  recordMessageComplete(): void {
    this.state.messageCount++;
    this.state.lastActivityAt = Date.now();
    this.debug(`Message ${this.state.messageCount} completed`);
    this.notifyStateChange();
  }

  /**
   * 记录已从 assistant 收到过内容。
   * 这条信息很关键——决定中止时是否要清空会话：如果还没收到任何内容就中止，
   * 会留下“半截”状态，恢复时容易出问题。
   * 仅在第一次收到内容时打日志、通知监听者，避免每条 message 都刷屏。
   */
  recordContentReceived(): void {
    if (!this.state.hasReceivedContent) {
      this.state.hasReceivedContent = true;
      this.debug('First content received');
      this.notifyStateChange();
    }
    this.state.lastActivityAt = Date.now();
  }

  /**
   * 设置当前中止原因。
   * @returns 上一次的中止原因（若有），便于调用方后续恢复。
   */
  setAbortReason(reason: AbortReason): AbortReason | null {
    const previous = this.currentAbortReason;
    this.currentAbortReason = reason;
    this.debug(`Abort reason set: ${reason}`);
    return previous;
  }

  /**
   * 取出并清空中止原因（一次性消费）。
   * 类似 Go 的“读 channel 后即丢弃”，保证一个 reason 只被处理一次。
   */
  consumeAbortReason(): AbortReason | null {
    const reason = this.currentAbortReason;
    this.currentAbortReason = null;
    return reason;
  }

  /** 只读地查看当前中止原因，不清空。 */
  getAbortReason(): AbortReason | null {
    return this.currentAbortReason;
  }

  /** 判断中止是不是用户主动触发的。 */
  wasUserAbort(): boolean {
    return this.currentAbortReason === AbortReason.UserStop;
  }

  /**
   * 判断本次中止是否应当清空会话状态。
   *
   * 清空条件：还没收到任何内容 AND 是第一条消息。
   * 这样可以避免留下“断在半路”的恢复状态——这种状态在 SDK resume 时容易出 bug。
   */
  shouldClearSessionOnAbort(): boolean {
    return !this.state.hasReceivedContent && this.state.messageCount === 0;
  }

  /** 停用会话（一般配合 dispose 调用）。 */
  deactivate(): void {
    this.state.isActive = false;
    this.currentAbortReason = null;
    this.debug('Session deactivated');
    this.notifyStateChange();
  }

  /** 为新对话重置状态（保留 sessionId，其余归零）。 */
  reset(): void {
    this.state = {
      sessionId: this.state.sessionId,
      isActive: true,
      messageCount: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      hasReceivedContent: false,
    };
    this.currentAbortReason = null;
    this.debug('Session reset');
    this.notifyStateChange();
  }

  /** 私有：通知外部监听者状态已变。`?.()` 在 onStateChange 为 undefined 时安全跳过。 */
  private notifyStateChange(): void {
    this.config.onStateChange?.(this.getState());
  }

  /** 私有：统一加前缀打调试日志。 */
  private debug(message: string): void {
    this.config.onDebug?.(`[SessionLifecycle] ${message}`);
  }
}

/**
 * 工厂函数：创建一个新的 SessionLifecycleManager。
 * 等价于 `new SessionLifecycleManager(config)`，提供这个函数主要是为了 API 风格统一。
 */
export function createSessionLifecycleManager(
  config: SessionLifecycleConfig
): SessionLifecycleManager {
  return new SessionLifecycleManager(config);
}
