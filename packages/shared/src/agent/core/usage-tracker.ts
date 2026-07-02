/**
 * UsageTracker —— 用量追踪器
 *
 * 用于追踪 agent session 的 token 使用量与上下文窗口占用情况。
 * 提供按消息（message）维度的精确计量（而不是按累计计费总量），
 * 主要服务于"实时上下文窗口占用"的 UI 展示。
 *
 * ClaudeAgent 与 PiAgent 都会使用它来：
 * - 追踪每条消息的 input / output token
 * - 计算缓存命中率（cache hit rate）
 * - 通过 usage_update 事件通知 UI 刷新展示
 * - 累计 session 总用量（用于计费/总量展示）
 */

// ============================================================
// 类型定义
// ============================================================

/**
 * 单条消息的 token 用量。
 */
export interface MessageUsage {
  /** 该条消息的总输入 token（包含缓存命中的 token） */
  inputTokens: number;

  /** 模型生成的输出 token 数 */
  outputTokens: number;

  /** 从缓存读取到的 token 数（缓存命中，价格更低） */
  cacheReadTokens: number;

  /** 写入到缓存的 token 数（本次新进入缓存的部分） */
  cacheCreationTokens: number;

  /** 该用量记录的时间戳（毫秒，等价于 Go 的 time.Now().UnixMilli()） */
  timestamp: number;
}

/**
 * 整个 session 的累计用量（用于计费/总量展示）。
 */
export interface SessionUsage {
  /** 跨所有消息累计的输入 token */
  totalInputTokens: number;
  /** 跨所有消息累计的输出 token */
  totalOutputTokens: number;
  /** 累计缓存读取 token */
  totalCacheReadTokens: number;
  /** 累计缓存写入 token */
  totalCacheCreationTokens: number;
  /** 已处理的消息/轮次数量 */
  messageCount: number;
  /** session 开始时间戳（毫秒） */
  startedAt: number;
}

/**
 * usage_update 事件的数据载荷（用于 UI 展示）。
 */
export interface UsageUpdate {
  /** 当前上下文大小（最近一条消息的 input token） */
  inputTokens: number;

  /** 模型的上下文窗口上限（最大可容纳 token 数） */
  contextWindow?: number;

  /** 缓存命中率，取值 0-1 */
  cacheHitRate?: number;
}

/**
 * UsageTracker 的配置参数。
 */
export interface UsageTrackerConfig {
  /** 当前模型使用的上下文窗口大小（最大 token 数） */
  contextWindow?: number;

  /** 用量更新回调（每次 recordMessageUsage 后会被调用） */
  onUsageUpdate?: (update: UsageUpdate) => void;

  /** 调试日志回调 */
  onDebug?: (message: string) => void;
}

// ============================================================
// UsageTracker 类
// ============================================================

/**
 * 追踪单个 agent session 的 token 用量。
 *
 * 提供：
 * - 按消息的用量追踪（用于精确显示上下文窗口占用）
 * - 累计 session 用量（用于计费总量）
 * - 缓存效率指标
 * - 实时 usage 更新事件
 */
export class UsageTracker {
  private config: UsageTrackerConfig;
  private sessionUsage: SessionUsage;
  private lastMessageUsage: MessageUsage | null = null;
  private cachedContextWindow?: number;

  constructor(config: UsageTrackerConfig = {}) {
    this.config = config;
    this.cachedContextWindow = config.contextWindow;
    // 初始化累计用量：所有计数归零，记录起始时间。
    this.sessionUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
      startedAt: Date.now(),
    };
  }

  /**
   * 记录一条 assistant 消息返回的用量。
   *
   * 在消息处理过程中调用，用于实时反映当前上下文占用情况。
   * 注意：这里不会累加到 session 总量，总量由 recordTurnComplete 维护。
   */
  recordMessageUsage(usage: {
    inputTokens: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    const now = Date.now();

    // 计算总输入：基础 input + 缓存读取 + 缓存写入
    // （API 计费时这三部分都会算进"已读"的上下文。）
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    const totalInput = usage.inputTokens + cacheRead + cacheCreation;

    // 覆盖"最近一条消息"的用量，用于 per-message 展示。
    this.lastMessageUsage = {
      inputTokens: totalInput,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      timestamp: now,
    };

    this.debug(`Message usage: ${totalInput} input, ${usage.outputTokens ?? 0} output, ${cacheRead} cache read`);

    // 触发一次 usage_update 事件，UI 据此刷新进度条等。
    this.emitUsageUpdate();
  }

  /**
   * 一轮对话（turn）结束时调用，把本轮用量累加到 session 总量。
   *
   * 若调用方未显式传入 usage，则使用 lastMessageUsage 作为本轮用量。
   */
  recordTurnComplete(usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    // 优先使用传入的 usage，否则回退到最后一次记录的消息用量。
    const finalUsage = usage ?? this.lastMessageUsage;

    if (finalUsage) {
      this.sessionUsage.totalInputTokens += finalUsage.inputTokens;
      this.sessionUsage.totalOutputTokens += finalUsage.outputTokens;
      this.sessionUsage.totalCacheReadTokens += finalUsage.cacheReadTokens ?? 0;
      this.sessionUsage.totalCacheCreationTokens += finalUsage.cacheCreationTokens ?? 0;
      this.sessionUsage.messageCount++;
    }

    this.debug(`Turn complete: ${this.sessionUsage.messageCount} messages, ${this.sessionUsage.totalInputTokens} total input`);
  }

  /**
   * 设置/更新上下文窗口大小。
   *
   * 当模型信息（如最大上下文长度）动态获知后再调用此方法即可更新。
   */
  setContextWindow(contextWindow: number): void {
    this.cachedContextWindow = contextWindow;
    this.debug(`Context window set: ${contextWindow}`);
  }

  /**
   * 获取当前的上下文窗口大小（未设置时为 undefined）。
   */
  getContextWindow(): number | undefined {
    return this.cachedContextWindow;
  }

  /**
   * 获取最近一条消息的用量（用于 per-message 展示）。
   * 返回的是副本，调用方修改不会影响内部状态。
   */
  getLastMessageUsage(): MessageUsage | null {
    return this.lastMessageUsage ? { ...this.lastMessageUsage } : null;
  }

  /**
   * 获取累计的 session 用量（用于计费/总量展示）。
   * 返回的是副本。
   */
  getSessionUsage(): SessionUsage {
    return { ...this.sessionUsage };
  }

  /**
   * 获取当前 input token 数（取最近一条消息）。
   *
   * 这代表实际上送给 API 的上下文大小。
   */
  getCurrentInputTokens(): number {
    return this.lastMessageUsage?.inputTokens ?? 0;
  }

  /**
   * 计算缓存命中率（0-1）。
   * 数值越高越好，意味着更多 token 命中了缓存（成本更低）。
   */
  getCacheHitRate(): number {
    const total = this.sessionUsage.totalInputTokens;
    if (total === 0) return 0;

    const cacheRead = this.sessionUsage.totalCacheReadTokens;
    return cacheRead / total;
  }

  /**
   * 返回当前上下文使用率百分比（0-100）。
   * 若未设置上下文窗口或还没有任何消息，则返回 undefined。
   */
  getContextUsagePercent(): number | undefined {
    if (!this.cachedContextWindow || !this.lastMessageUsage) {
      return undefined;
    }

    return (this.lastMessageUsage.inputTokens / this.cachedContextWindow) * 100;
  }

  /**
   * 判断上下文是否趋近饱和（> 80%）。
   * UI 通常会用黄色告警提示用户。
   */
  isContextFilling(): boolean {
    const percent = this.getContextUsagePercent();
    return percent !== undefined && percent > 80;
  }

  /**
   * 判断上下文是否已临界（> 95%）。
   * UI 通常会用红色提示，建议立即清理/重启会话。
   */
  isContextCritical(): boolean {
    const percent = this.getContextUsagePercent();
    return percent !== undefined && percent > 95;
  }

  /**
   * 重置所有用量统计（用于开启新的 session）。
   */
  reset(): void {
    this.sessionUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
      startedAt: Date.now(),
    };
    this.lastMessageUsage = null;
    this.debug('Usage tracker reset');
  }

  /**
   * 构造一个 UsageUpdate 对象，供 emit 使用。
   */
  buildUsageUpdate(): UsageUpdate {
    return {
      inputTokens: this.getCurrentInputTokens(),
      contextWindow: this.cachedContextWindow,
      cacheHitRate: this.getCacheHitRate(),
    };
  }

  private emitUsageUpdate(): void {
    this.config.onUsageUpdate?.(this.buildUsageUpdate());
  }

  private debug(message: string): void {
    this.config.onDebug?.(`[UsageTracker] ${message}`);
  }
}

/**
 * 工厂函数：创建一个新的 UsageTracker。
 * 等价于 Go 里 `NewUsageTracker(config)` 的便捷构造器。
 */
export function createUsageTracker(config?: UsageTrackerConfig): UsageTracker {
  return new UsageTracker(config);
}
