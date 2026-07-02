/**
 * Source-activation 自动重启的"排空控制器"（issue #790）。
 *
 * 背景（Agent 概念）：
 * 当一个 session 级工具（`mcp__session__source_test`）在一轮对话（turn）进行中
 * 成功激活了一个新 source（数据源 / MCP server）时，Agent 必须提前结束当前 turn，
 * 好让渲染层带上新启用的工具重新发送用户消息。这是因为新 source 对应的工具
 * 只有在下一轮请求里才会真正可用。
 *
 * 问题：朴素的"一看到 tool_result 就立即 abort 当前 turn"的做法会丢掉同一批
 * 并行工具调用（parallel-tool batch）里其它兄弟 tool_result，导致 Craft 的
 * session journal 中残留孤立的 `tool_use` ID，进而阻塞后续所有发送。
 *
 * 解决：本控制器把 abort 推迟（defer）。Agent 照常 yield（产出）事件流，
 * 但在每次产出前/后告诉控制器，由控制器决定：
 *   - 是否要跳过针对单个事件的常规处理（如 inactive-source 检测、压缩重置、
 *     大结果拦截）—— 因为我们只是在"排空"这批事件，不需要再走这些逻辑。
 *   - 是否到达合适的边界，触发 `source_activated` + `forceAbort`。
 *
 * 两种排空策略（构造时选定，DrainPolicy）：
 *
 *   - `'batch-boundary'`（Claude 用）：适配后的事件数组天然就是一个 batch。
 *     Claude 的事件适配器会在一个 SDK user message 内的 `tool_result` 之间
 *     插入合成事件（`task_backgrounded`、`shell_backgrounded`、`shell_killed`），
 *     因此必须把整批排空后再触发。调用方在 batch 末尾 / stream 末尾通过
 *     `shouldFireAtBoundary()` 驱动触发。
 *
 *   - `'fire-on-non-tool-result'`（Pi 用）：适配器是 1:1，没有插入的合成事件，
 *     因此捕获到重启后，遇到的第一个非 `tool_result` 事件就标志着下一个
 *     assistant turn 开始，是天然的排空边界。调用方在每个事件 yield 之前
 *     通过 `shouldFireBeforeEvent()` 驱动触发。
 */

import type { AgentEvent } from '@craft-agent/core/types';

/** 捕获到的"待重启"信息：要激活的 source slug + 需要重发的用户消息。 */
export interface PendingActivationRestart {
  sourceSlug: string;
  userMessage: string;
}

/** 发给上层的事件：表示 source 已被激活，应被 yield 到事件流中。 */
export interface SourceActivatedEvent {
  type: 'source_activated';
  sourceSlug: string;
  originalMessage: string;
}

/** 排空策略：见文件头注释。 */
export type DrainPolicy = 'batch-boundary' | 'fire-on-non-tool-result';

/**
 * Source 激活的排空控制器。
 *
 * 类比 Golang：可以理解为一个有状态的小型状态机，类似 sync 中的 once/cond，
 * 确保多次调用只触发一次 fire。
 */
export class SourceActivationDrainController {
  /** 当前捕获到的待重启请求；为 null 表示尚未捕获。 */
  private captured: PendingActivationRestart | null = null;
  /** 是否已经发出过 `source_activated`；保证幂等（最多 fire 一次）。 */
  private fired: boolean = false;

  constructor(private readonly policy: DrainPolicy) {}

  /**
   * 仅 `'fire-on-non-tool-result'` 策略使用的"事件 yield 前"检查。
   *
   * 含义：当我们已经捕获到重启请求，并且即将 yield 的不是 `tool_result`，
   * 说明并行工具批次已经结束（下一个 assistant turn 即将开始）—— 这就是排空边界。
   *
   * 返回一个 `source_activated` 事件，要求调用方在 yield 该边界事件**之前**先把它
   * yield 出去。边界事件本身属于"我们即将取消的下一个 assistant turn"，如果放它
   * 过去，会把被取消响应的一个片段泄漏到 session journal 中。
   *
   * 其它所有情况（包括 `'batch-boundary'` 策略下的任何调用）返回 null。
   */
  shouldFireBeforeEvent(event: AgentEvent): SourceActivatedEvent | null {
    if (this.policy !== 'fire-on-non-tool-result') return null;
    if (!this.captured || this.fired) return null;
    if (event.type === 'tool_result') return null;
    return this.takeFire();
  }

  /**
   * 在 yield 某个事件之前更新控制器状态。
   *
   * 返回 true 表示调用方应该"yield 后直接 continue"，即跳过针对单个事件的常规
   * 处理（inactive-source 检测、压缩重置、大结果拦截）。这适用于：
   *   - 首次捕获（第一个 `consumePending()` 返回记录的 `tool_result`）
   *   - 捕获之后排空期间 yield 的每一个事件
   *
   * 返回 false 表示调用方应走正常流程（yield + 后续 agent 逻辑）。
   *
   * @param event 即将 yield 的事件
   * @param consumePending 调用方提供的函数：从外部待处理队列里取出（并清掉）一个
   *                       PendingActivationRestart；没有则返回 null。
   */
  observe(
    event: AgentEvent,
    consumePending: () => PendingActivationRestart | null,
  ): boolean {
    // 已 fire，退出排空模式，按正常流程处理。
    if (this.fired) return false;
    if (this.captured) {
      if (event.type === 'tool_result') {
        // 清掉来自并发 source_test 的"竞争型"待处理重启（多个 source_test 同时
        // 在第一个 winner 之后才落地）。保留首个被捕获的 slug。
        consumePending();
      }
      return true;
    }
    // 尚未捕获：仅 tool_result 事件有机会触发首次捕获。
    if (event.type === 'tool_result') {
      const pending = consumePending();
      if (pending) {
        this.captured = pending;
        return true;
      }
    }
    return false;
  }

  /**
   * batch 末尾（Claude）与 stream 末尾（两种策略均用）的检查。
   *
   * 返回调用方应该 yield 的 `source_activated` 事件；无需触发则返回 null。
   * 首次返回非 null 后幂等（后续调用继续返回 null）。
   */
  shouldFireAtBoundary(): SourceActivatedEvent | null {
    if (!this.captured || this.fired) return null;
    return this.takeFire();
  }

  /** 实际构造 fire 事件并标记已触发。 */
  private takeFire(): SourceActivatedEvent {
    const captured = this.captured;
    if (!captured) {
      throw new Error('SourceActivationDrainController.takeFire() called with no captured restart');
    }
    this.fired = true;
    return {
      type: 'source_activated',
      sourceSlug: captured.sourceSlug,
      originalMessage: captured.userMessage,
    };
  }

  /** 当前已捕获的 source slug，没有则 null；用于诊断/调试。 */
  get capturedSlug(): string | null {
    return this.captured?.sourceSlug ?? null;
  }

  /** 是否已经通过任意 fire 路径发出过 `source_activated`。 */
  get hasFired(): boolean {
    return this.fired;
  }
}
