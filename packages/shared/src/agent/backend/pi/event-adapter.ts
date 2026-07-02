/**
 * Pi SDK 事件适配器（Event Adapter）
 *
 * 本适配器把 Pi Agent Core 发出的细粒度生命周期事件（AgentEvent /
 * AgentSessionEvent）翻译成 Craft Agent 内部的 AgentEvent 格式，
 * 让渲染层无需关心后端差异。
 *
 * Pi 会发出一系列细颗粒度的事件，我们把它们翻译成渲染层已经理解的
 * 事件词汇——这套词汇与 Claude / Codex / Copilot 后端共用，
 * 类似 Go 里一边读 channel 一边转换消息体再转发。
 *
 * 事件映射表：
 * - message_update（其中 assistantMessageEvent 的 text_delta）→ text_delta
 * - message_end → text_complete
 * - tool_execution_start → tool_start
 * - tool_execution_end → tool_result
 * - agent_end → complete
 * - compaction_start → status（带 "Compacting" 关键词）
 * - compaction_end → info / error
 * - auto_retry_start → status
 * - auto_retry_end → status
 * - queue_update → 忽略（当前没有 UI 消费方）
 *
 * 为什么需要 overflow-recovery（上下文超长恢复）状态机：
 * 当模型返回 context_length_exceeded（上下文超长）错误时，Pi SDK 的
 * `_checkCompaction` 会触发 `_runAutoCompaction("overflow", true)` 压缩
 * 历史，并在成功后调用 `agent.continue()` 重试。这个恢复轮次会"晚于"
 * 原始的 `agent_end` 事件到达。如果我们按历史行为在原始 `agent_end`
 * 上就 yield `complete` 并调用 `eventQueue.complete()`，恢复轮会落到
 * 一个已经关闭的迭代器里——事件丢失、UI 卡死。下面的状态机在 SDK 的
 * 恢复流程期间保持事件队列开启，让恢复轮的回复能正常到达 UI。
 */

import type { AgentEvent as CraftAgentEvent } from '@craft-agent/core/types';
import type {
  AgentEvent as PiAgentEvent,
} from '@earendil-works/pi-agent-core';
import type {
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { PI_TOOL_NAME_MAP } from './constants.ts';
import { toolMetadataStore } from '../../../interceptor-common.ts';
import { parseError } from '../../errors.ts';

/**
 * Pi SDK 自动压缩竞态（auto-compaction race）的特征签名——即 `_runAutoCompaction`
 * （`@earendil-works/pi-coding-agent` 的 agent-session.ts）中描述的 AbortController 崩溃。
 * 当两次 `_runAutoCompaction` 调用重叠时，其中一个的 `finally` 会清空共享的
 * `_autoCompactionAbortController` 字段，而另一个仍挂起在 await 上；下一次读取
 * `.signal` 时就会崩溃。我们用这个正则去匹配 `compaction_end.errorMessage`，
 * 在上游修复落地之前给用户展示友好提示，而不是裸露的调用栈。
 * 参见 plans/fix-pi-gpt-compaction.md。
 */
const SDK_AUTOCOMPACT_RACE_SIGNATURE = /_autoCompactionAbortController\.signal/;

/** 在"压住的" overflow `agent_end` 之后，等待一个 `compaction_start` 的最长容忍时间；
 *  超时则放弃并暴露原始错误。SDK 会在同一事件队列 tick 上触发 `_checkCompaction`，
 *  所以唯一的延迟来自事件序列化——5 秒远高于任何可能的抖动。 */
const OVERFLOW_FALLBACK_TIMEOUT_MS = 5_000;

/**
 * 本适配器能处理的合并事件类型。
 * AgentSessionEvent 是 PiAgentEvent 的超集（额外增加了 compaction_*、
 * auto_retry_*、queue_update）。
 */
type PiEvent = PiAgentEvent | AgentSessionEvent;

/**
 * 把 Pi SDK 事件映射为 Craft AgentEvent，供 UI 直接消费。
 *
 * 事件映射：
 * - message_update（其中 assistantMessageEvent 的 text_delta）→ text_delta
 * - message_end → text_complete
 * - tool_execution_start → tool_start
 * - tool_execution_end → tool_result
 * - agent_end → complete
 * - compaction_start → status（带 "Compacting" 关键词）
 * - compaction_end → info/error
 * - auto_retry_start → status
 * - auto_retry_end → status
 * - queue_update → 忽略（当前没有 UI 消费方）
 */
export class PiEventAdapter extends BaseEventAdapter {
  // 在 tool_execution_start 时记录工具名，便于后续 tool_execution_end 正确关联。
  // Map<K,V>：TS 的内置映射类型，类似 Go 的 map[K]V。
  // private：访问修饰符，表示仅类内部可见。
  private toolNames: Map<string, string> = new Map();

  // 标记当前消息是否已经收到过流式增量（streaming deltas）。
  private hasStreamedDeltas: boolean = false;

  // 标记本回合是否已经发出过最终（非中间态）的 text_complete。
  private hasEmittedFinalText: boolean = false;

  // 在单个 Pi 回合内，为每次工具调用/文本块生成独立的 sub-turnId，做隔离。
  private subTurnCounter: number = 0;
  private messageSubTurnId: string | null = null;

  // 模型的上下文窗口大小，供 usage_update 事件使用。
  private contextWindow: number | undefined;

  // call_llm 显示用的默认 mini model id（#596）。
  // 当调用方没有显式指定 model 时使用——我们在 tool_start 事件里填充 args.model，
  // 让 UI 显示生效的默认值，而不是让徽标空白。
  private miniModel: string | undefined;

  // 记录最近一次 usage，用于随 complete 事件一起发出。
  private lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } | undefined;

  // ============================================================
  // Overflow-recovery（上下文超长恢复）状态机
  // ============================================================
  //
  // 当 Pi 路由的 assistant 消息返回 context_length_exceeded（上下文超长）错误时，
  // Pi SDK 的 `_checkCompaction` 会触发 `_runAutoCompaction("overflow", true)`，
  // 成功后再调用 `agent.continue()` 重试。这个恢复轮的到达晚于原始的 `agent_end`。
  // 如果我们按历史行为在原始 `agent_end` 上就 yield `complete` 并调用
  // `eventQueue.complete()`，恢复轮会落到一个已关闭的迭代器里。下面的状态机
  // 在 SDK 的整个恢复流程期间保持事件队列开启，让恢复轮的回复能到达 UI。
  //
  // overflowState 的 5 个状态与转移条件：
  // - 'none'       ：空闲态，未发生 overflow 恢复。
  // - 'held'       ：在 message_end 检测到 overflow 错误，已"压住"原始错误，
  //                  等待随后的 agent_end 触发恢复流程。
  // - 'awaiting'   ：原始 agent_end 已到，已启动 fallback 兜底定时器，
  //                  等待 SDK 的 compaction_start 出现。
  // - 'compacting' ：收到 compaction_start，正在执行自动压缩，
  //                  等待 compaction_end 决定成功（→ recovering）或失败（→ 终结）。
  // - 'recovering' ：压缩成功，等待恢复轮的 agent_end，到达后回到 'none' 并正常 complete。
  private overflowState: 'none' | 'held' | 'awaiting' | 'compacting' | 'recovering' = 'none';
  private heldOverflowError: string | null = null;
  // ReturnType<typeof setTimeout>：取 setTimeout 的返回类型（Node 下是 Timer，
  // 浏览器下是 number），保证跨运行时类型正确。
  private fallbackTimerId: ReturnType<typeof setTimeout> | null = null;
  /** 当适配器希望调用方在非 `agent_end` 事件（例如 `compaction_end` 失败）上
   *  调用 `eventQueue.complete()` 时置位。由 `shouldCompleteQueue()` 消费。 */
  private pendingQueueComplete: boolean = false;
  /** 调用方注入的、用于异步 fallback 定时器路径的回调——定时器在
   *  `adaptEvent()` 之外触发，无法通过生成器 yield 事件。 */
  private onFallbackEvent: ((event: CraftAgentEvent) => void) | null = null;
  private onFallbackComplete: (() => void) | null = null;

  /** 构造函数：以 'pi-event' 作为日志来源初始化基类。 */
  constructor() {
    super('pi-event');
  }

  /**
   * 设置模型的上下文窗口大小，供 usage 上报使用。
   */
  setContextWindow(cw: number): void {
    this.contextWindow = cw;
  }

  /**
   * 注册 overflow 恢复 fallback 定时器触发时调用的处理器。
   * 触发条件：在压住的 overflow `agent_end` 之后，SDK 在
   * `OVERFLOW_FALLBACK_TIMEOUT_MS` 内未发出 `compaction_start`。
   * 适配器会先调用 `onEvent` 把缓冲的原始错误入队，再调用
   * `onComplete` 终止迭代器。
   */
  setOverflowFallbackHandlers(
    onEvent: (event: CraftAgentEvent) => void,
    onComplete: () => void,
  ): void {
    this.onFallbackEvent = onEvent;
    this.onFallbackComplete = onComplete;
  }

  /**
   * 判断调用方在处理完本次 SDK 事件后是否应该调用 `eventQueue.complete()`。
   * 历史规则是"在 `agent_end` 上总是 complete"；引入 overflow 恢复后，
   * 我们要把 complete 推迟到恢复轮结束（或恢复失败 / 超时）再触发。
   */
  shouldCompleteQueue(isAgentEnd: boolean): boolean {
    if (this.pendingQueueComplete) {
      this.pendingQueueComplete = false;
      return true;
    }
    return isAgentEnd && this.overflowState === 'none';
  }

  /**
   * 重置 overflow 恢复状态。在 session 销毁时调用，避免已拆卸的 adapter
   * 上还残留 fallback 定时器触发。
   */
  resetOverflowState(): void {
    this.cancelOverflowFallbackTimer();
    this.overflowState = 'none';
    this.heldOverflowError = null;
    this.pendingQueueComplete = false;
  }

  private armOverflowFallbackTimer(): void {
    this.cancelOverflowFallbackTimer();
    this.fallbackTimerId = setTimeout(() => {
      this.fallbackTimerId = null;
      // 触发时再次检查状态 —— 一个迟到的 `compaction_start` 可能已经把我们推进 `compacting`。
      if (this.overflowState !== 'awaiting') return;
      const errorMessage = this.heldOverflowError ?? 'Context overflow';
      this.heldOverflowError = null;
      this.overflowState = 'none';
      this.log.warn('Overflow recovery fallback fired — SDK emitted no compaction events', {
        timeoutMs: OVERFLOW_FALLBACK_TIMEOUT_MS,
      });
      this.onFallbackEvent?.({ type: 'error', message: errorMessage });
      this.onFallbackComplete?.();
    }, OVERFLOW_FALLBACK_TIMEOUT_MS);
  }

  private cancelOverflowFallbackTimer(): void {
    if (this.fallbackTimerId !== null) {
      clearTimeout(this.fallbackTimerId);
      this.fallbackTimerId = null;
    }
  }

  /**
   * 设置 call_llm 徽标默认使用的 mini model ID。
   * 当 agent 调用 call_llm 时没传 `args.model`，我们用这个值兜底，
   * 让 UI 徽标显示实际生效的默认值而不是空白。agent 显式传入的 `args.model` 永远保留。
   */
  setMiniModel(model: string | undefined): void {
    this.miniModel = model;
  }

  /**
   * 为当前 turn 内的一个文本块生成唯一的 sub-turnId。
   */
  private nextSubTurnId(prefix: string): string {
    const base = this.currentTurnId || 'unknown';
    return `${base}__${prefix}${this.subTurnCounter++}`;
  }

  protected onTurnStart(): void {
    this.toolNames.clear();
    this.hasStreamedDeltas = false;
    this.hasEmittedFinalText = false;
    this.subTurnCounter = 0;
    this.messageSubTurnId = null;
    this.log.debug('Turn started', { turnIndex: this.turnIndex });
  }

  /**
   * 把一个 Pi SDK 事件转换成零个或多个 Craft AgentEvent。
   */
  *adaptEvent(event: PiEvent): Generator<CraftAgentEvent> {
    // 来自 pi-agent-server 的 Craft 注入事件（不属于 Pi SDK 原生事件）。
    // 子进程在每个 `message_end` 之后立即发送它，用于交付正确的 `sdkTurnAnchor`
    //（SDK 已经把 assistant 条目追加到叶节点之后的 id）。我们原样透传 ——
    // SessionManager 会通过 `sdkMessageId` 把它和这里创建的 Craft assistant
    // 消息关联起来。参见 craft-agents-oss#782。
    if ((event as { type?: string }).type === 'pi_turn_anchor') {
      const e = event as unknown as { sdkMessageId?: string; sdkTurnAnchor?: string };
      if (e.sdkMessageId && e.sdkTurnAnchor) {
        yield {
          type: 'pi_turn_anchor',
          sdkMessageId: e.sdkMessageId,
          sdkTurnAnchor: e.sdkTurnAnchor,
        };
      }
      return;
    }

    switch (event.type) {
      // ============================================================
      // Agent 生命周期事件
      // ============================================================

      case 'agent_start':
        // 内部事件 —— agent 运行已开始
        break;

      case 'agent_end':
        // Overflow 恢复：在 SDK 执行 _runAutoCompaction("overflow") + agent.continue()
        // 期间保持队列开启。恢复轮会作为一个新的 agent_start … agent_end 对到达。
        if (this.overflowState === 'held') {
          this.overflowState = 'awaiting';
          this.armOverflowFallbackTimer();
          break;
        }
        if (this.overflowState === 'awaiting' || this.overflowState === 'compacting') {
          // 防御性处理：在恢复中途收到 agent_end 不符合 SDK 常规流程。
          // 保持队列开启，等待 compaction_end（成功 → recovering，失败 → 结束）。
          break;
        }
        if (this.overflowState === 'recovering') {
          // 恢复轮刚结束 —— 落到正常 complete 分支。
          this.overflowState = 'none';
        }
        if (this.lastUsage) {
          const inputTokens = this.lastUsage.input + (this.lastUsage.cacheRead || 0);
          yield {
            type: 'complete',
            usage: {
              inputTokens,
              outputTokens: this.lastUsage.output,
              cacheReadTokens: this.lastUsage.cacheRead,
              cacheCreationTokens: this.lastUsage.cacheWrite,
              costUsd: this.lastUsage.cost.total,
              contextWindow: this.contextWindow,
            },
          };
        } else {
          yield { type: 'complete' };
        }
        break;

      // ============================================================
      // Turn 事件
      // ============================================================

      case 'turn_start':
        // Pi SDK 的 turn_start 没有 ID，我们自己生成一个用于事件关联。
        this.currentTurnId = `pi-turn-${this.turnIndex}`;
        break;

      case 'turn_end':
        // 不要在这里发 'complete' —— agent_end 会统一处理。
        // 两边都发会导致 session 持久化里出现重复消息。
        this.currentTurnId = null;
        this.hasStreamedDeltas = false;
        this.hasEmittedFinalText = false;
        this.subTurnCounter = 0;
        this.messageSubTurnId = null;
        break;

      // ============================================================
      // Message 事件（文本流）
      // ============================================================

      case 'message_start':
        // Pi SDK 对 user 消息也会发 message_start —— 跳过非 assistant 的。
        break;

      case 'message_update': {
        // Pi SDK 只对 assistant 消息发 message_update（流式增量）。
        const amEvent: AssistantMessageEvent = event.assistantMessageEvent;
        if (amEvent.type === 'text_delta' && amEvent.delta) {
          this.hasStreamedDeltas = true;
          if (!this.messageSubTurnId) {
            this.messageSubTurnId = this.nextSubTurnId('m');
          }
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: this.messageSubTurnId,
          };
        }
        break;
      }

      case 'message_end': {
        // Pi SDK 对所有消息（user、assistant、toolResult）都会发 message_end。
        // 只处理 assistant 消息 —— 跳过 user prompt 和 tool result。
        const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } }; id?: string } | undefined;
        // SDK message id，由 pi-agent-server 转发事件时设置。
        // SessionManager 用它把后续的 `pi_turn_anchor` 事件和这里创建的
        // Craft assistant 消息关联起来（#782）。
        const sdkMessageId = (event as { sdkMessageId?: string }).sdkMessageId ?? msg?.id;
        if (msg?.role !== 'assistant') break;

        // 暴露 API 错误 —— Pi SDK 失败时会设置 stopReason: 'error' 和 errorMessage。
        if (msg.stopReason === 'error' && msg.errorMessage) {
          // 上下文溢出：把恢复交给 SDK 的 _runAutoCompaction，在结果出来前
          // 保持 UI 安静（恢复轮到达，或压缩失败）。此时抑制原始 provider 错误。
          if (
            this.overflowState === 'none' &&
            isContextOverflow(event.message as AssistantMessage, this.contextWindow)
          ) {
            this.overflowState = 'held';
            this.heldOverflowError = msg.errorMessage;
            break;
          }

          // 错误分类 —— auth/billing 类错误应该被标记为 typed_error，
          // 这样 SessionManager 才能触发鉴权重试流程（刷新 token + 重发）。
          const parsed = parseError(new Error(msg.errorMessage));
          const isClassified = parsed.code !== 'unknown_error';
          if (isClassified) {
            yield { type: 'typed_error', error: parsed };
          } else {
            yield { type: 'error', message: msg.errorMessage };
          }
          break;
        }

        // 从最终 assistant 消息里提取文本内容
        const textContent = this.extractTextFromMessage(event.message);
        // Pi SDK stopReason: 'toolUse' 表示模型接下来要调用工具（中间评论）；
        // 'stop'/'end_turn' 表示最终回复。和 Claude 的 stop_reason === 'tool_use' 同逻辑。
        const isIntermediate = msg.stopReason === 'toolUse';
        if (textContent && (isIntermediate || !this.hasEmittedFinalText)) {
          if (!isIntermediate) this.hasEmittedFinalText = true;

          const mTurnId = this.messageSubTurnId || this.nextSubTurnId('m');
          this.messageSubTurnId = null;

          yield {
            type: 'text_complete',
            text: textContent,
            isIntermediate,
            turnId: mTurnId,
            sdkMessageId,
          };
          this.hasStreamedDeltas = false;
        }

        // 若 assistant 消息包含 token 用量，则发出 usage_update
        if (msg.usage && typeof msg.usage.input === 'number') {
          this.lastUsage = msg.usage;
          const inputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          yield {
            type: 'usage_update',
            usage: {
              inputTokens,
              contextWindow: this.contextWindow,
            },
          };
        }
        break;
      }

      // ============================================================
      // Tool 事件
      // ============================================================

      case 'tool_execution_start': {
        const toolCallId = event.toolCallId;
        const toolName = this.resolveToolName(event.toolName);
        this.toolNames.set(toolCallId, toolName);

        // 把 Pi 的字段名归一化为 Claude Code 格式，保证 UI 兼容
        //（diff 统计、diff overlay、文档路由都按 Claude Code 格式处理）。
        const args = this.normalizeToolInput(toolName, (event.args ?? {}) as Record<string, unknown>);

        // call_llm 调用方没显式指定 model 时，填入默认展示模型。
        // Pi 的 call_llm 默认使用 miniModel；我们只做补缺，
        // 绝不会覆盖 agent 显式提供的 model（这是 #596 的 bug）。
        if (toolName.includes('call_llm') && this.miniModel && !args.model) {
          args.model = this.miniModel;
        }

        // 来自子进程事件 payload 的权威元数据（interceptor/bridge 权威路径）。
        const eventMeta = this.extractToolMetadataFromEvent(event);

        // 向后兼容的兜底：共享元数据 store（旧版旁路），
        // 并对混合 call-id 格式做规范化回退。
        const { meta: storedMeta, keyTried } = this.resolveStoredMetadata(toolCallId);

        // 最后一层兜底：若 args 里自带元数据则使用。
        const argsIntent = typeof args._intent === 'string' ? args._intent : undefined;
        const argsDisplayName = typeof args._displayName === 'string' ? args._displayName : undefined;

        const intent = eventMeta?.intent
          || storedMeta?.intent
          || argsIntent
          || (typeof args.description === 'string' ? args.description : undefined);

        const displayName = eventMeta?.displayName
          || storedMeta?.displayName
          || argsDisplayName
          || this.getToolDisplayName(toolName);

        const metadataSource = eventMeta
          ? 'event'
          : storedMeta
            ? `store(${keyTried})`
            : (argsIntent || argsDisplayName)
              ? 'args'
              : (typeof args.description === 'string')
                ? 'description'
                : 'fallback';

        this.log.debug('Tool metadata resolution', {
          toolName,
          toolCallId,
          metadataSource,
          hasIntent: !!intent,
          hasDisplayName: !!displayName,
        });

        // 把实际上是读文件的 bash 命令归类为 Read
        if (toolName === 'Bash' && typeof args.command === 'string') {
          const readInfo = this.classifyReadCommand(toolCallId, args.command);
          if (readInfo) {
            yield this.createReadToolStart(
              toolCallId,
              readInfo,
              intent,
              'Read File',
            );
            break;
          }
        }

        yield this.createToolStart(
          toolCallId,
          toolName,
          args,
          intent,
          displayName,
        );
        break;
      }

      case 'tool_execution_update': {
        // 累积流式 tool result 的部分输出
        const partialResult = event.partialResult;
        if (partialResult && typeof partialResult === 'object') {
          const content = (partialResult as { content?: Array<{ type: string; text?: string }> }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'text' && part.text) {
                this.accumulateOutput(event.toolCallId, part.text);
              }
            }
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId;
        const resolvedToolName = this.toolNames.get(toolCallId) || 'tool';
        this.toolNames.delete(toolCallId);

        // 检查是否有拦截原因
        const blockReason = this.consumeBlockReason(toolCallId, resolvedToolName);

        // 若已有累积的部分输出，优先使用
        const accumulatedOutput = this.consumeOutput(toolCallId);

        const isError = event.isError;
        let result: string;

        if (accumulatedOutput) {
          result = accumulatedOutput;
        } else if (blockReason) {
          result = blockReason;
        } else {
          result = this.extractToolResult(event.result, isError);
        }

        // 工具完成后，assistant 可能会生成新的文本
        this.hasEmittedFinalText = false;
        this.messageSubTurnId = null;

        // 检查该工具是否被归类为读文件
        const readInfo = this.consumeReadCommand(toolCallId);
        if (readInfo) {
          yield this.createToolResult(toolCallId, 'Read', result, isError);
          break;
        }

        yield this.createToolResult(toolCallId, resolvedToolName, result, isError);
        break;
      }

      // ============================================================
      // Session 级事件（AgentSessionEvent 扩展）
      // ============================================================

      case 'compaction_start':
        // 取消 overflow fallback 定时器 —— SDK 已经在主动恢复，
        // 不再需要"没有 compaction 事件到达"的安全网。状态转移：held|awaiting → compacting。
        if (this.overflowState === 'held' || this.overflowState === 'awaiting') {
          this.cancelOverflowFallbackTimer();
          this.overflowState = 'compacting';
        }
        // 使用 "Compacting" 关键词，让 session handler 识别 statusType: 'compacting'
        yield { type: 'status', message: 'Compacting context...' };
        break;

      case 'compaction_end': {
        const compactionEvent = event as Extract<AgentSessionEvent, { type: 'compaction_end' }>;
        if (compactionEvent.result && !compactionEvent.aborted) {
          // 成功：保持开启并等待恢复后的 agent_end。状态转移：compacting → recovering。
          // 如果是阈值触发的压缩（state 为 'none'），只发 info 然后正常继续。
          if (this.overflowState === 'compacting') {
            this.overflowState = 'recovering';
            this.heldOverflowError = null;
          }
          // 使用 "Compacted" 关键词，让 session handler 识别 statusType: 'compaction_complete'
          yield { type: 'info', message: 'Compacted context to fit within limits' };
        } else if (compactionEvent.errorMessage) {
          // 对 Pi SDK 自动压缩竞态的防御性处理（plans/fix-pi-gpt-compaction.md 中的 cause A）。
          // 原始堆栈 `undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')`
          // 对用户不友好；转成可重试提示并记录日志用于诊断。上游修复后可将这段移除。
          if (SDK_AUTOCOMPACT_RACE_SIGNATURE.test(compactionEvent.errorMessage)) {
            this.log.warn('Pi SDK auto-compaction race; recommend manual /compact', {
              errorMessage: compactionEvent.errorMessage,
            });
            yield {
              type: 'error',
              message: 'Auto-compaction hit a transient error. Try /compact manually.',
            };
          } else {
            yield {
              type: 'error',
              message: `Context compaction failed: ${compactionEvent.errorMessage}`,
            };
          }
          // 如果之前为了 overflow 恢复而保持队列开启，现在必须收尾 ——
          // 失败路径不会有恢复后的 agent_end 到达。pendingQueueComplete
          // 通知调用方终止迭代器，因为触发点不是 agent_end。
          if (
            this.overflowState === 'compacting' ||
            this.overflowState === 'awaiting' ||
            this.overflowState === 'held'
          ) {
            yield { type: 'complete' };
            this.pendingQueueComplete = true;
            this.overflowState = 'none';
            this.heldOverflowError = null;
            this.cancelOverflowFallbackTimer();
          }
        }
        break;
      }

      case 'auto_retry_start': {
        const retryEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_start' }>;
        yield {
          type: 'status',
          message: `Retrying (attempt ${retryEvent.attempt}/${retryEvent.maxAttempts})...`,
        };
        break;
      }

      case 'auto_retry_end': {
        const retryEndEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_end' }>;
        if (!retryEndEvent.success && retryEndEvent.finalError) {
          yield { type: 'error', message: `Retry failed: ${retryEndEvent.finalError}` };
        }
        break;
      }

      case 'queue_update':
        // 队列内容目前已经由现有 session/message 状态反映。
        // 显式忽略该事件，避免新版 Pi SDK session 在还没添加专门 UI 消费者前
        // 打印大量 "Unknown Pi event" 警告。
        break;

      default:
        this.log.warn(`Unknown Pi event type: ${(event as { type: string }).type}`);
        break;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * 从增强的 tool_execution_start 事件中提取权威的工具元数据。
   * 这是由 pi-agent-server 发出的 interceptor 权威路径。
   */
  private extractToolMetadataFromEvent(event: PiEvent): { intent?: string; displayName?: string } | undefined {
    const metadata = (event as {
      toolMetadata?: { intent?: unknown; displayName?: unknown };
    }).toolMetadata;

    if (!metadata) return undefined;

    const intent = typeof metadata.intent === 'string' ? metadata.intent : undefined;
    const displayName = typeof metadata.displayName === 'string' ? metadata.displayName : undefined;

    if (!intent && !displayName) return undefined;
    return { intent, displayName };
  }

  /**
   * 按 tool call id 查找已存储的元数据，并带变体回退。
   * 对 `call_xxx|fc_yyy` 这类混合 id 会尝试 base id。
   */
  private resolveStoredMetadata(toolCallId: string): { meta?: { intent?: string; displayName?: string }; keyTried?: string } {
    const candidates = new Set<string>([toolCallId]);
    if (toolCallId.includes('|')) {
      const [base] = toolCallId.split('|');
      if (base) candidates.add(base);
    }

    for (const candidate of candidates) {
      const meta = toolMetadataStore.get(candidate, this.sessionDir);
      if (meta) return { meta, keyTried: candidate };
    }

    return { meta: undefined, keyTried: Array.from(candidates).join(' -> ') };
  }

  /**
   * 把 Pi SDK 的工具参数字段名归一化为 Claude Code 格式。
   * Pi 使用 camelCase（oldText, newText, path），而 Claude Code 使用
   * snake_case（old_string, new_string, file_path）。UI 管线按 Claude Code
   * 格式做 diff 计算、overlay 渲染和文档类型检测。
   */
  private normalizeToolInput(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'Edit') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }

      // Pi SDK >= 0.63.2 用 edits[] 数组代替顶层的 oldText/newText。
      // 保留完整 edits[] payload，让渲染器可以展开显示每一个替换块；
      // 同时把第一个 edit 推导成扁平的 old/new 字段，作为仍期望旧字段的 UI 路径的兼容桥接。
      const edits = normalized.edits as Array<{ oldText?: string; newText?: string }> | undefined;
      if (Array.isArray(edits) && edits.length > 0 && edits[0]) {
        const first = edits[0];
        if (first.oldText != null && !('old_string' in normalized)) {
          normalized.old_string = first.oldText;
        }
        if (first.newText != null && !('new_string' in normalized)) {
          normalized.new_string = first.newText;
        }
      }

      // 旧版路径：顶层 oldText/newText（Pi SDK < 0.63.2 或恢复出来的 session）
      if ('oldText' in normalized && !('old_string' in normalized)) {
        normalized.old_string = normalized.oldText;
        delete normalized.oldText;
      }
      if ('newText' in normalized && !('new_string' in normalized)) {
        normalized.new_string = normalized.newText;
        delete normalized.newText;
      }
      return normalized;
    }

    if (toolName === 'Write') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    return args;
  }

  /**
   * 把 Pi 工具名解析为 PascalCase，保证 UI 展示一致性。
   * Pi 工具名是小写的（read, write, edit, bash, grep, find, ls）。
   */
  private resolveToolName(rawName: string): string {
    return PI_TOOL_NAME_MAP[rawName] || rawName;
  }

  /**
   * 从 Pi AgentMessage 中提取文本内容。
   * Pi 消息采用 pi-ai 的 Message 格式，content 是数组。
   */
  private extractTextFromMessage(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;

    const msg = message as {
      role?: string;
      content?: string | Array<{ type: string; text?: string }>;
    };

    if (typeof msg.content === 'string') {
      return msg.content || null;
    }

    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      return textParts.length > 0 ? textParts.join('') : null;
    }

    return null;
  }

  /**
   * 从 Pi 工具执行结果中提取字符串形式的结果。
   */
  private extractToolResult(result: unknown, isError: boolean): string {
    if (!result) {
      return isError ? 'Tool execution failed' : 'Success';
    }

    if (typeof result === 'string') return result;

    // Pi 工具结果遵循 AgentToolResult 形状：{ content: [...], details: ... }
    const typed = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    };

    if (Array.isArray(typed.content)) {
      const texts = typed.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      if (texts.length > 0) return texts.join('\n');
    }

    // 回退到 JSON 序列化
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  /**
   * 获取工具的人类可读展示名。
   */
  private getToolDisplayName(toolName: string): string | undefined {
    switch (toolName) {
      case 'Bash':
        return 'Run Command';
      case 'Read':
        return 'Read File';
      case 'Write':
        return 'Write File';
      case 'Edit':
        return 'Edit File';
      case 'Glob':
      case 'Find':
        return 'Search Files';
      case 'Grep':
        return 'Search Content';
      case 'Ls':
        return 'List Directory';
      default:
        return undefined;
    }
  }
}
