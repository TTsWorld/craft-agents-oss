/**
 * Claude Event Adapter（事件适配器）
 *
 * 把 Claude SDK 的消息（SDKMessage）映射成 Craft Agent 内部统一的 AgentEvent。
 * 原本耦合在 ClaudeAgent.convertSDKMessage() 里，抽出来便于测试，
 * 也方便和 PiEventAdapter 共享 BaseEventAdapter 的生命周期骨架。
 *
 * Claude 特有的关键行为：
 * - 使用 tool-matching.ts 中的 extractToolStarts/extractToolResults（无状态、基于 ID）
 * - 处理 stream_event：实时文本增量、工具开始检测
 * - 管理 pendingText：text_complete 推迟到 message_delta 携带 stop_reason 后再发
 * - 用 per-message（非累计）的 usage 来准确显示上下文窗口占用
 *
 * 概念说明：
 * - “Agent / tool use”：模型不再只输出文本，而是输出“要调用哪个工具”，由宿主执行后
 *   回传结果。SDK 就是把这一来一回抽象成各种 SDKMessage。
 * - “stream / handler”：SDK 边产生事件边推送，宿主这边的事件适配器相当于一个
 *   翻译 handler（类似 Go 的 http.Handler，输入是 SDKMessage，输出是 AgentEvent）。
 */

import type { SDKMessage, SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@craft-agent/core/types';
import type { AgentError } from '../../errors.ts';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { ToolIndex, extractToolStarts, extractToolResults, isParentTaskTool, type ContentBlock } from '../../tool-matching.ts';

/**
 * ClaudeAdapterCallbacks：ClaudeAgent 注入给适配器的回调集合。
 * 这些回调都依赖 agent 自身的状态（比如 debug 日志、sessionDir），所以以函数形式传入。
 */
export interface ClaudeAdapterCallbacks {
  /** Debug 日志钩子，由 ClaudeAgent.onDebug 提供。可选属性（?:）表示可不存在 */
  onDebug?: (msg: string) => void;
  /**
   * 把 SDK 的 errorCode 映射为带类型的 AgentError。
   * 依赖 debug 日志解析（不同错误的区分往往藏在 stderr 文本里）。
   */
  mapSDKError: (errorCode: SDKAssistantMessageError) => Promise<{ type: 'typed_error'; error: AgentError }>;
  /** 当前 session 的目录路径，用于读取工具元数据；防止跨 session 竞态 */
  sessionDir?: string;
}

/**
 * 纯函数：针对 Windows SDK 安装环境问题，构造一个 typed_error 事件。
 * 如果错误文本不符合特征则返回 null。
 *
 * 返回值用联合类型 `| null` 表示“可能没有产出”，调用方需要做 null 检查。
 */
export function buildWindowsSkillsDirError(errorText: string): { type: 'typed_error'; error: AgentError } | null {
  // 同时包含 ENOENT 与 skills 关键字才认作 skills 目录缺失
  if (!errorText.includes('ENOENT') || !errorText.includes('skills')) {
    return null;
  }

  // 从错误文本里抠出具体路径，匹配形如 scandir 'C:\path'
  const pathMatch = errorText.match(/scandir\s+'([^']+)'/);
  // 找不到则给一个 Windows 上的常见默认路径作为兜底
  const missingPath = pathMatch?.[1] || 'C:\\ProgramData\\ClaudeCode\\.claude\\skills';

  return {
    type: 'typed_error',
    error: {
      code: 'unknown_error',
      title: 'Windows Setup Required',
      message: `The SDK requires a directory that doesn't exist: ${missingPath} — Create this folder in File Explorer, then restart the app.`,
      details: [
        `PowerShell (run as Administrator):`,
        `New-Item -ItemType Directory -Force -Path "${missingPath}"`,
      ],
      actions: [],
      canRetry: true,
      originalError: errorText,
    },
  };
}

/**
 * 单条 assistant 消息的 token 用量快照，用于精确显示上下文窗口占用。
 * 注意：result.modelUsage 是累计值，这里需要 per-message 粒度。
 *
 * interface 在 TS 中类似 Go 的 struct，描述字段形状。
 */
interface AssistantUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * SDK `task_notification` 系统消息的结构。
 * SDK 没有导出此类型，所以我们在这里本地定义，并在使用前手动校验字段，
 * 以便 SDK 静默变更字段时能尽早暴露问题。
 */
interface TaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status?: string;
  output_file?: string;
  summary?: string;
  session_id?: string;
}

/** 后台任务（Task 工具）的合法终止状态 */
const VALID_TASK_STATUSES = ['completed', 'failed', 'stopped'] as const;
/**
 * `typeof X[number]`：从只读元组推出其元素类型的联合，
 * 等价于 `'completed' | 'failed' | 'stopped'`。
 */
type TaskStatus = typeof VALID_TASK_STATUSES[number];

/**
 * ClaudeEventAdapter：单实例对应一次 session 的整个生命周期。
 * 继承 BaseEventAdapter 拿到 turnId、turnIndex 等通用状态。
 */
export class ClaudeEventAdapter extends BaseEventAdapter {
  // ============================================================
  // 单轮（turn）内状态：每个 turn 开始时重置
  // ============================================================
  private toolIndex = new ToolIndex();
  // 已发过 tool_start 事件的工具调用 ID，避免重复发送
  private emittedToolStarts = new Set<string>();
  // 当前活跃的“父任务工具”ID 集合，用于回退式父级归属
  private activeParentTools = new Set<string>();
  // 暂存的文本，等待 message_delta 携带 stop_reason 之后再决定是否为中间结果
  private pendingText: string | null = null;

  // ============================================================
  // Session 级持久状态：跨 turn 保留
  // ============================================================
  // 最近一次 assistant 消息的 token 用量（per-message）
  private lastAssistantUsage: AssistantUsage | null = null;
  // 缓存的上下文窗口大小
  private cachedContextWindow?: number;
  // 从 init 消息捕获的 SDK 工具名列表
  private _sdkTools: string[] = [];

  private callbacks: ClaudeAdapterCallbacks;

  constructor(callbacks: ClaudeAdapterCallbacks) {
    // 传入 'claude-adapter' 作为适配器名（用于父类日志/调试）
    super('claude-adapter');
    this.callbacks = callbacks;
  }

  // ============================================================
  // Turn 生命周期
  // ============================================================

  /**
   * 每个 turn 开始时清空单轮状态。基类会在 startTurn 时回调此方法。
   */
  protected onTurnStart(): void {
    this.toolIndex = new ToolIndex();
    this.emittedToolStarts = new Set();
    this.activeParentTools = new Set();
    this.pendingText = null;
    this.lastAssistantUsage = null;
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * 把一条 SDK 消息转换成若干 AgentEvent。
   * 这是 ClaudeAgent 在 for-await 循环里调用的主入口。
   */
  async adapt(message: SDKMessage): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // 调试：记录非 stream_event 的 SDK 消息类型（stream_event 太频繁）
    if (this.callbacks.onDebug && message.type !== 'stream_event') {
      // `in` 操作符判断对象上是否存在某属性；`'x' in obj` 类似检查字段是否存在
      const msgInfo = message.type === 'user' && 'tool_use_result' in message
        ? `user (tool_result for ${(message as any).parent_tool_use_id})`
        : message.type;
      this.callbacks.onDebug(`SDK message: ${msgInfo}`);
    }

    // 根据消息类型分发到对应的处理函数
    switch (message.type) {
      case 'assistant':
        await this.adaptAssistant(message, events);
        break;

      case 'stream_event':
        this.adaptStreamEvent(message, events);
        break;

      case 'user':
        this.adaptUser(message, events);
        break;

      case 'tool_progress':
        this.adaptToolProgress(message, events);
        break;

      case 'result':
        this.adaptResult(message, events);
        break;

      case 'system':
        this.adaptSystem(message, events);
        break;

      case 'auth_status':
        this.adaptAuthStatus(message, events);
        break;

      default:
        // 未识别的消息类型：仅记日志，不影响流程
        if (this.callbacks.onDebug) {
          this.callbacks.onDebug(`Unhandled SDK message type: ${(message as any).type}`);
        }
        break;
    }

    return events;
  }

  /**
   * 刷出尚未发送的暂存文本。
   * 在 for-await 循环结束之后调用，处理边界场景
   * （例如 SDK 发了带文本的 assistant 消息，但没发 message_delta）。
   */
  flushPending(): AgentEvent | null {
    if (this.pendingText) {
      const event: AgentEvent = {
        type: 'text_complete',
        text: this.pendingText,
        isIntermediate: false,
        // 可选链 `?.`：若左侧为 null/undefined 则整体表达式为 undefined
        turnId: this.currentTurnId || undefined,
      };
      this.pendingText = null;
      return event;
    }
    return null;
  }

  /**
   * 取出从 init 消息捕获的 SDK 工具名列表。
   * getter 写法：访问 `adapter.sdkTools` 即可，无需写 `getSdkTools()`。
   */
  get sdkTools(): string[] {
    return this._sdkTools;
  }

  /**
   * 取出 toolIndex（供 agent 层做 inactive source 检测等操作使用）。
   */
  getToolIndex(): ToolIndex {
    return this.toolIndex;
  }

  /**
   * 取出当前活跃的父任务工具集合（暴露给 source 激活检测使用）。
   */
  getActiveParentTools(): Set<string> {
    return this.activeParentTools;
  }

  /**
   * 更新 session 目录，用于工具元数据查询。
   */
  updateSessionDir(sessionDir: string): void {
    this.callbacks.sessionDir = sessionDir;
  }

  // ============================================================
  // 按消息类型分发的 handler
  // ============================================================

  /** 处理 assistant 消息：模型回复（含文本/工具调用） */
  private async adaptAssistant(message: SDKMessage, events: AgentEvent[]): Promise<void> {
    // 优先检测 SDK 层错误（鉴权、网络、限流等），命中则直接发出 typed_error 并返回
    if ('error' in message && message.error) {
      const errorEvent = await this.callbacks.mapSDKError(
        message.error as SDKAssistantMessageError,
      );
      events.push(errorEvent);
      return;
    }

    // session 恢复时跳过回放消息
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // 仅追踪主链路（非 sidechain）的 assistant 消息 token 用量
    const isSidechain = (message as any).parent_tool_use_id !== null;
    if (!isSidechain && (message as any).message?.usage) {
      const usage = (message as any).message.usage;
      this.lastAssistantUsage = {
        input_tokens: usage.input_tokens,
        // `?? 0`：nullish coalescing，仅当左侧为 null/undefined 时取右侧
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      };

      // 当前输入 token = 实际输入 + 命中缓存读 + 缓存创建
      const currentInputTokens =
        this.lastAssistantUsage.input_tokens +
        this.lastAssistantUsage.cache_read_input_tokens +
        this.lastAssistantUsage.cache_creation_input_tokens;

      events.push({
        type: 'usage_update',
        usage: {
          inputTokens: currentInputTokens,
          contextWindow: this.cachedContextWindow,
        },
      });
    }

    // 完整的 assistant 消息体（含 content blocks）
    const content = (message as any).message?.content ?? [];

    // 从 content blocks 里抽取文本
    let textContent = '';
    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    // 无状态抽取工具开始事件（基于 content blocks + tool index）
    const sdkParentId = (message as any).parent_tool_use_id;
    const toolStartEvents = extractToolStarts(
      content as ContentBlock[],
      sdkParentId,
      this.toolIndex,
      this.emittedToolStarts,
      this.currentTurnId || undefined,
      this.activeParentTools,
      this.callbacks.sessionDir,
    );

    // 把新发现的 Task 工具记录到 activeParentTools，便于后续回退式父级归属
    for (const event of toolStartEvents) {
      if (event.type === 'tool_start' && isParentTaskTool(event.toolName)) {
        this.activeParentTools.add(event.toolUseId);
      }
    }

    events.push(...toolStartEvents);

    if (textContent) {
      // 暂不发出 text_complete，等 message_delta 携带 stop_reason 后再决定中间态
      this.pendingText = textContent;
    }
  }

  /** 处理流式事件：实时文本增量、工具开始检测 */
  private adaptStreamEvent(message: SDKMessage, events: AgentEvent[]): void {
    const event = (message as any).event;

    // 调试：仅记录关键 stream 事件（跳过逐块 delta 与高频 ping）
    if (this.callbacks.onDebug && (event.type === 'message_start' || event.type === 'message_stop')) {
      this.callbacks.onDebug(
        `stream_event: ${event.type}`,
      );
    }

    // 从 message_start 抓取 turnId（用消息 id 作 turnId，便于事件关联）
    if (event.type === 'message_start') {
      const messageId = event.message?.id;
      if (messageId) {
        this.currentTurnId = messageId;
      }
    }

    // message_delta 携带真正的 stop_reason：此时把暂存文本发出去
    if (event.type === 'message_delta') {
      const stopReason = event.delta?.stop_reason;
      if (this.pendingText) {
        // 工具调用导致的中间停顿标记为 intermediate
        const isIntermediate = stopReason === 'tool_use';
        events.push({
          type: 'text_complete',
          text: this.pendingText,
          isIntermediate,
          turnId: this.currentTurnId || undefined,
          parentToolUseId: (message as any).parent_tool_use_id || undefined,
        });
        this.pendingText = null;
      }
    }

    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      // 文本增量：直接发出
      events.push({
        type: 'text_delta',
        text: event.delta.text,
        turnId: this.currentTurnId || undefined,
        parentToolUseId: (message as any).parent_tool_use_id || undefined,
      });
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      // 流式事件到达时 input 为空——完整 input 会在后续事件里补齐
      const toolBlock = event.content_block;
      const sdkParentId = (message as any).parent_tool_use_id;
      const streamBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: toolBlock.id,
        name: toolBlock.name,
        input: (toolBlock.input ?? {}) as Record<string, unknown>,
      }];
      const streamEvents = extractToolStarts(
        streamBlocks,
        sdkParentId,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // 把新发现的 Task/Agent 工具记入 activeParentTools
      for (const evt of streamEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...streamEvents);
    }
  }

  /** 处理 user 消息：通常是工具执行结果回传 */
  private adaptUser(message: SDKMessage, events: AgentEvent[]): void {
    // session 恢复时跳过回放
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // 工具结果匹配
    if ((message as any).tool_use_result !== undefined || ('message' in message && (message as any).message)) {
      const msgContent = ('message' in message && (message as any).message)
        ? (((message as any).message as { content?: unknown[] }).content ?? [])
        : [];
      // 断言 + 守卫：保证后续按数组处理
      const contentBlocks = (Array.isArray(msgContent) ? msgContent : []) as ContentBlock[];

      const sdkParentId = (message as any).parent_tool_use_id;
      const toolUseResultValue = (message as any).tool_use_result;

      const resultEvents = extractToolResults(
        contentBlocks,
        sdkParentId,
        toolUseResultValue,
        this.toolIndex,
        this.currentTurnId || undefined,
      );

      // 已结束的 Task/Agent 工具从 activeParentTools 中移除
      for (const event of resultEvents) {
        if (event.type === 'tool_result' && isParentTaskTool(event.toolName ?? '')) {
          this.activeParentTools.delete(event.toolUseId);
        }
      }

      events.push(...resultEvents);
    }
  }

  /** 处理 tool_progress：工具执行过程中的进度上报 */
  private adaptToolProgress(message: SDKMessage, events: AgentEvent[]): void {
    const progress = message as unknown as {
      tool_use_id: string;
      tool_name: string;
      parent_tool_use_id: string | null;
      elapsed_time_seconds?: number;
    };

    // 把已耗时间转成 task_progress 事件，UI 可据此显示实时进度
    if (progress.elapsed_time_seconds !== undefined) {
      events.push({
        type: 'task_progress',
        toolUseId: progress.parent_tool_use_id || progress.tool_use_id,
        elapsedSeconds: progress.elapsed_time_seconds,
        turnId: this.currentTurnId || undefined,
      });
    }

    // 对“通过进度事件首次发现”的工具，补发一个 tool_start
    if (!this.emittedToolStarts.has(progress.tool_use_id)) {
      const progressBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: progress.tool_use_id,
        name: progress.tool_name,
        input: {},
      }];
      const progressEvents = extractToolStarts(
        progressBlocks,
        progress.parent_tool_use_id,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // 通过进度事件发现的 Task/Agent 工具也要登记
      for (const evt of progressEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...progressEvents);
    }
  }

  /** 处理 result：每轮结束的总结消息（含 usage、错误信息） */
  private adaptResult(message: SDKMessage, events: AgentEvent[]): void {
    const msg = message as any;

    // 调试日志：输出 subtype 与 errors（直接打 stderr，便于排查）
    console.error(
      `[ClaudeAdapter] result message: subtype=${msg.subtype}, errors=${'errors' in msg ? JSON.stringify(msg.errors) : 'none'}`,
    );

    // 从 modelUsage 中读取上下文窗口大小
    const modelUsageEntries = Object.values(msg.modelUsage || {});
    const primaryModelUsage = modelUsageEntries[0] as any;

    if (primaryModelUsage?.contextWindow) {
      this.cachedContextWindow = primaryModelUsage.contextWindow;
    }

    // 注意：用 per-message 的 usage 显示上下文占用，不用累计值
    let inputTokens: number;
    let cacheRead: number;
    let cacheCreation: number;

    if (this.lastAssistantUsage) {
      inputTokens = this.lastAssistantUsage.input_tokens +
                    this.lastAssistantUsage.cache_read_input_tokens +
                    this.lastAssistantUsage.cache_creation_input_tokens;
      cacheRead = this.lastAssistantUsage.cache_read_input_tokens;
      cacheCreation = this.lastAssistantUsage.cache_creation_input_tokens;
    } else {
      // 兜底：使用 result 自带的累计 usage
      cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      cacheCreation = msg.usage.cache_creation_input_tokens ?? 0;
      inputTokens = msg.usage.input_tokens + cacheRead + cacheCreation;
    }

    const usage = {
      inputTokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      costUsd: msg.total_cost_usd,
      contextWindow: primaryModelUsage?.contextWindow,
    };

    if (msg.subtype === 'success') {
      events.push({ type: 'complete', usage });
    } else {
      // 失败：把错误文本聚合，必要时尝试识别 Windows skills 目录错误
      const errorMsg = 'errors' in msg ? msg.errors.join(', ') : 'Query failed';

      const windowsError = buildWindowsSkillsDirError(errorMsg);
      if (windowsError) {
        events.push(windowsError);
      } else {
        events.push({ type: 'error', message: errorMsg });
      }
      // 失败也补发 complete，让上层把这一轮收尾
      events.push({ type: 'complete', usage });
    }
  }

  /** 处理 system 消息：init / compact / status / task_notification 等 */
  private adaptSystem(message: SDKMessage, events: AgentEvent[]): void {
    const msg = message as any;

    if (msg.subtype === 'init') {
      // 从 init 消息中捕获 SDK 注册的工具列表
      if ('tools' in msg && Array.isArray(msg.tools)) {
        this._sdkTools = msg.tools;
        this.callbacks.onDebug?.(`SDK init: captured ${this._sdkTools.length} tools`);
      }
    } else if (msg.subtype === 'compact_boundary') {
      // 历史压缩完成边界
      events.push({
        type: 'info',
        message: 'Compacted Conversation',
      });
    } else if (msg.subtype === 'status' && msg.status === 'compacting') {
      // 正在压缩历史
      events.push({ type: 'status', message: 'Compacting conversation...' });
    } else if (msg.subtype === 'task_notification') {
      // 后台任务（Task 工具）状态变更
      const notification = msg as TaskNotificationMessage;
      if (!notification.task_id) {
        this.callbacks.onDebug?.('[EventAdapter] task_notification missing task_id, skipping');
        return;
      }
      // 校验 status：未知值一律降级为 completed
      const status: TaskStatus = VALID_TASK_STATUSES.includes(notification.status as TaskStatus)
        ? (notification.status as TaskStatus)
        : 'completed';
      events.push({
        type: 'task_completed',
        taskId: notification.task_id,
        status,
        outputFile: notification.output_file,
        summary: notification.summary,
        turnId: this.currentTurnId || undefined,
      });
    }
  }

  /** 处理 auth_status：鉴权状态变化 */
  private adaptAuthStatus(message: SDKMessage, events: AgentEvent[]): void {
    const msg = message as any;
    if (msg.error) {
      events.push({
        type: 'error',
        message: `Auth error: ${msg.error}. Try running /auth to re-authenticate.`,
      });
    }
  }
}
