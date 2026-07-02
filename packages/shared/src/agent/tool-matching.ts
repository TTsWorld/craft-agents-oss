/**
 * SDK 消息 → AgentEvent 转换过程中用到的「无状态工具匹配」工具集。
 *
 * 本模块从 SDK 消息的 content block（内容块）中提取 tool_start（工具开始）
 * 与 tool_result（工具结果）事件，使用「直接按 ID 匹配」的方式，而非 FIFO 队列匹配。
 *
 * 核心原则：所有输出都由「当前消息 + 一个只追加（append-only）的工具索引」推导得到。
 * 不使用任何可变队列、栈或依赖顺序的状态。
 *
 * SDK 提供以下字段：
 * - `parent_tool_use_id`：每条消息都带，用于标识 subagent（子 Agent）上下文（Task 的 ID 或 null）
 * - `tool_use_id`：每个 tool_result 内容块上都带，直接指明该结果属于哪个工具调用
 *
 * 上述两个字段合在一起，让我们无需 FIFO 配对、父栈维护或孤儿结果回收。
 */

import type { AgentEvent } from '@craft-agent/core/types';
import { toolMetadataStore } from '../interceptor-common.ts';
import { createLogger } from '../utils/debug.ts';
import { isParentTaskTool } from '../utils/toolNames.ts';

// 模块级 logger，类比 Go 中带前缀的 structured logger
const log = createLogger('tool-matching');

// 从无浏览器环境依赖的模块中再导出，保持向后兼容（旧导入路径仍可用）
export { PARENT_TASK_TOOLS, isParentTaskTool } from '../utils/toolNames.ts';

/**
 * Parse the workflow run id (`wf_...`) from a subagent transcript path (or any
 * string containing one). Workflow sub-agent transcripts live under
 * `.../subagents/workflows/<wf_id>/agent-<id>.jsonl`, so this both (a) extracts
 * the id from the Workflow tool result's "Transcript dir:" line and (b) attributes
 * a SubagentStop's transcript path to the owning workflow. Returns null for
 * non-workflow paths (ordinary sub-agents live under `.../subagents/agent-*`).
 */
export function parseWorkflowIdFromTranscriptPath(path: string | undefined): string | null {
  if (!path) return null;
  // The id charset [A-Za-z0-9_-] naturally bounds the match (it stops at `/`,
  // `.`, whitespace or newline), so no explicit terminator is needed — and adding
  // one breaks the "Transcript dir:" tail case where the id is followed by \n.
  const m = path.match(/\/workflows\/(wf_[A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

// ============================================================================
// Tool Index —— 只追加、与插入顺序无关的查询表
// ============================================================================

/**
 * 单条工具调用的元信息条目。
 */
export interface ToolEntry {
  name: string;
  input: Record<string, unknown>;
}

/**
 * 工具元信息的「只追加」索引，由 tool_start 事件构建。
 * 与顺序无关：先插 A 再插 B，与先插 B 再插 A 结果一致。
 * 用于在处理 tool_result 内容块时反查工具名 / 输入参数
 * （tool_result 块只携带 tool_use_id，不携带 tool_name）。
 *
 * 类比 Go：相当于 map[string]ToolEntry，但约定只能写入、不修改已有项。
 */
export class ToolIndex {
  private entries = new Map<string, ToolEntry>();

  /**
   * 注册一条工具调用信息（幂等——同一 ID 永远映射到同一条目）。
   *
   * 流式事件早期可能 input 为空对象，后续 assistant 消息到达时 input 才完整；
   * 此处保证：当已有空 input 时，会用更完整的数据覆盖。
   */
  register(toolUseId: string, name: string, input: Record<string, unknown>): void {
    // 当已有条目且其 input 为空，但新 input 有内容时，更新（流式事件以空 input 开始）
    const existing = this.entries.get(toolUseId);
    if (existing && Object.keys(existing.input).length === 0 && Object.keys(input).length > 0) {
      this.entries.set(toolUseId, { name, input });
    } else if (!existing) {
      this.entries.set(toolUseId, { name, input });
    }
  }

  /** 根据工具调用 ID 获取工具名 */
  getName(toolUseId: string): string | undefined {
    return this.entries.get(toolUseId)?.name;
  }

  /** 根据工具调用 ID 获取输入参数 */
  getInput(toolUseId: string): Record<string, unknown> | undefined {
    return this.entries.get(toolUseId)?.input;
  }

  /** 根据工具调用 ID 获取完整条目（名称 + 输入） */
  getEntry(toolUseId: string): ToolEntry | undefined {
    return this.entries.get(toolUseId);
  }

  /** 索引中是否包含该工具调用 ID */
  has(toolUseId: string): boolean {
    return this.entries.has(toolUseId);
  }

  /** 当前已注册的工具数量 */
  get size(): number {
    return this.entries.size;
  }
}

// ============================================================================
// 内容块类型定义（仅取本模块需要用到的 Anthropic SDK 类型子集）
// ============================================================================

/** assistant（助手）消息中的 tool_use 内容块：表示一次工具调用请求 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** user（用户）消息中的 tool_result 内容块：表示某次工具调用的返回结果 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

/** 文本类型的内容块 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 本模块能处理的内容块联合类型（其余未知类型退化为 { type: string }） */
export type ContentBlock = ToolUseBlock | ToolResultBlock | TextBlock | { type: string };

// ============================================================================
// 纯函数：事件抽取
// ============================================================================

/** 从工具 input 中剔除内部元数据字段（_displayName、_intent），避免泄漏到上层 */
function stripInternalFields(input: unknown): Record<string, unknown> {
  // 解构后用 rest 把不要的字段排除，类似 Go 中复制 struct 时省略某些字段
  const { _displayName, _intent, ...clean } = input as Record<string, unknown>;
  return clean;
}

/**
 * 从 assistant 消息的内容块中抽取 tool_start 事件。
 *
 * 每个 tool_use 块都会对应生成一个 tool_start 事件。
 * 父级归属直接来自 SDK 消息上的 parent_tool_use_id 字段——无需栈或 FIFO。
 *
 * 兜底逻辑：当 SDK 的 parent_tool_use_id 为 null 且当前恰好只有 1 个活跃 Task 时，
 * 把该 Task 作为父级。这用于处理 SDK 未为 subagent 子工具提供 parent 信息的情况。
 *
 * @param contentBlocks - 来自 SDKAssistantMessage.message.content 的内容块数组
 * @param sdkParentToolUseId - SDK 消息上的 parent_tool_use_id（null 表示顶层）
 * @param toolIndex - 只追加索引，新工具会被注册进去
 * @param emittedToolStartIds - 已发出过 tool_start 的工具 ID 集合（用于 stream 与 assistant 去重）
 * @param turnId - 当前 turn（一轮对话）的关联 ID
 * @param activeParentTools - 当前活跃的 Task 工具 ID 集合（兜底分配父级时用）
 * @param sessionDir - session 目录路径，用于读取工具元数据（避免多 session 并发覆盖单例导致的竞态）
 * @returns 抽取出的 tool_start AgentEvent 数组
 */
export function extractToolStarts(
  contentBlocks: ContentBlock[],
  sdkParentToolUseId: string | null,
  toolIndex: ToolIndex,
  emittedToolStartIds: Set<string>,
  turnId?: string,
  activeParentTools?: Set<string>,
  sessionDir?: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const block of contentBlocks) {
    // 只处理 tool_use 类型，其余类型直接跳过
    if (block.type !== 'tool_use') continue;
    const toolBlock = block as ToolUseBlock;

    // 注册到索引（幂等——同时覆盖流式与 assistant 两种事件来源）
    toolIndex.register(toolBlock.id, toolBlock.name, toolBlock.input);

    // 确定父级：SDK 的 parent_tool_use_id 是权威来源。
    // 兜底：SDK 给 null 且当前恰好有 1 个活跃 Task 时，将该 Task 作为子工具的父级。
    // 这样能修复 SDK 未为 subagent 子工具提供 parent 信息的场景。
    let parentToolUseId: string | undefined;
    if (sdkParentToolUseId) {
      // SDK 显式给出了父级，直接采用
      parentToolUseId = sdkParentToolUseId;
    } else if (activeParentTools && activeParentTools.size === 1) {
      // 兜底：当前仅 1 个活跃 Task，把它作为子工具的父级。
      // 当多个 Task 同时活跃时无法安全分配（存在歧义），因此不处理。
      // 另外，若当前工具自身就是这个 Task，则不分配（避免自引用）。
      const [singleActiveParent] = activeParentTools;
      if (toolBlock.id !== singleActiveParent) {
        parentToolUseId = singleActiveParent;
      }
    }

    // 去重：stream_event 通常先于 assistant 消息到达，两者包含相同的 tool_use 块。
    // 该 Set 是只追加且与顺序无关的（同一 ID 永远以同样方式去重）。
    if (emittedToolStartIds.has(toolBlock.id)) {
      // 已在流式阶段发出过——仅当本次带来了新有用数据时才再发一次：
      // 1) assistant 消息此时已携带完整 input（流式起始 input 为空 {}）
      // 2) toolMetadataStore 后续才到位的元数据（规避竞态）
      const hasNewInput = Object.keys(toolBlock.input).length > 0;
      const { intent, displayName } = extractToolMetadata(toolBlock, sessionDir);
      const hasMetadataUpdate = !!intent || !!displayName;
      if (hasNewInput || hasMetadataUpdate) {
        events.push({
          type: 'tool_start',
          toolName: toolBlock.name,
          toolUseId: toolBlock.id,
          input: stripInternalFields(toolBlock.input),
          intent,
          displayName,
          turnId,
          parentToolUseId,
        });
      }
      continue;
    }

    // 记录该 ID 已发出，避免后续重复触发
    emittedToolStartIds.add(toolBlock.id);

    const { intent, displayName } = extractToolMetadata(toolBlock, sessionDir);

    events.push({
      type: 'tool_start',
      toolName: toolBlock.name,
      toolUseId: toolBlock.id,
      input: stripInternalFields(toolBlock.input),
      intent,
      displayName,
      turnId,
      parentToolUseId,
    });
  }

  return events;
}

/**
 * 从 user 消息的内容块中抽取 tool_result 事件。
 *
 * 每个 tool_result 内容块都显式携带 `tool_use_id`，可直接定位其归属的工具调用，无需 FIFO 匹配。
 *
 * 当内容块中不含 tool_result 条目时（某些 MCP 工具的回包就是如此），
 * 回落到便捷字段 `tool_use_result` + `parent_tool_use_id`。
 *
 * @param contentBlocks - 来自 SDKUserMessage.message.content 的内容块数组（可能为空）
 * @param sdkParentToolUseId - SDK 消息上的 parent_tool_use_id
 * @param toolUseResultValue - SDK 消息上的便捷字段 tool_use_result
 * @param toolIndex - 只读查询表，用于反查工具名 / 输入
 * @param turnId - 当前 turn（一轮对话）的关联 ID
 * @returns 抽取出的 tool_result AgentEvent 数组（也可能包含后台任务相关事件）
 */
export function extractToolResults(
  contentBlocks: ContentBlock[],
  sdkParentToolUseId: string | null,
  toolUseResultValue: unknown,
  toolIndex: ToolIndex,
  turnId?: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  // 主路径：直接从内容块中筛出 tool_result 类型，并读取其 tool_use_id
  const toolResultBlocks = contentBlocks.filter(
    (b): b is ToolResultBlock => b.type === 'tool_result'
  );

  if (toolResultBlocks.length > 0) {
    // 直接按 ID 匹配——每个块都显式标注了自己归属的工具
    for (const block of toolResultBlocks) {
      const toolUseId = block.tool_use_id;
      const entry = toolIndex.getEntry(toolUseId);

      const resultStr = serializeResult(block.content);
      const isError = block.is_error ?? isToolResultError(block.content);

      events.push({
        type: 'tool_result',
        toolUseId,
        toolName: entry?.name,
        result: resultStr,
        isError,
        input: entry?.input,
        turnId,
        parentToolUseId: sdkParentToolUseId ?? undefined,
      });

      // 从结果文本中识别后台任务 / 后台 shell 等附加事件
      if (entry) {
        const bgEvents = detectBackgroundEvents(toolUseId, entry, resultStr, isError, turnId);
        events.push(...bgEvents);
      }
    }
  } else if (toolUseResultValue !== undefined) {
    // 兜底路径：当内容块中拿不到 tool_result 时，使用便捷字段。
    // 这用于一些边界情况，例如进程内 MCP 工具不提供 tool_result 内容块。
    //
    // 当 sdkParentToolUseId 有值时，它指向工具自身的 ID（适用于走便捷 API 的常规工具），
    // 因此直接把它当作 toolUseId 使用。
    // 当其为 null（顶层工具且没有内容块）时，生成一个合成 ID，避免结果被静默丢弃。
    //
    // 这里 parentToolUseId 故意置为 undefined：兜底路径下我们只有一个 ID，
    // 若同时当作 toolUseId 和 parentToolUseId，会形成自引用环。父级不明时，
    // 安全默认是把这个工具当作顶层处理。
    const toolUseId = sdkParentToolUseId ?? `fallback-${turnId ?? 'unknown'}`;
    const entry = toolIndex.getEntry(toolUseId);

    const resultStr = serializeResult(toolUseResultValue);
    const isError = isToolResultError(toolUseResultValue);

    events.push({
      type: 'tool_result',
      toolUseId,
      toolName: entry?.name,
      result: resultStr,
      isError,
      input: entry?.input,
      turnId,
      parentToolUseId: undefined,
    });

    if (entry) {
      const bgEvents = detectBackgroundEvents(toolUseId, entry, resultStr, isError, turnId);
      events.push(...bgEvents);
    }
  }

  return events;
}

// ============================================================================
// 辅助函数（纯函数，无副作用）
// ============================================================================

/**
 * 为一次工具调用抽取 intent（意图）与 displayName（展示名）元数据。
 *
 * 数据来源（按优先级从高到低）：
 * 1. toolMetadataStore——由 unified-network-interceptor.ts 中的 SSE 剥离流填充
 * 2. toolBlock.input._intent / _displayName——Codex 后端或未走 SSE 拦截时的兜底
 * 3. Bash 的 description 字段——对 Bash 工具，缺失 intent 时作为兜底
 */
function extractToolMetadata(toolBlock: ToolUseBlock, sessionDir?: string): { intent?: string; displayName?: string } {
  // 1. 先查 metadata store（由 SSE 拦截器填充）
  // 传入 sessionDir 以避免「单例 _sessionDir 被并发 session 覆盖」时读到错误 session 的文件
  const idCandidates = new Set<string>([toolBlock.id]);
  // ID 中可能带有 '|' 分隔符，取其 base 部分再作为候选，应对某些后端拼接 ID 的场景
  if (toolBlock.id.includes('|')) {
    const [base] = toolBlock.id.split('|');
    if (base) idCandidates.add(base);
  }

  for (const candidate of idCandidates) {
    const stored = toolMetadataStore.get(candidate, sessionDir);
    if (!stored) continue;

    let intent = stored.intent;
    const displayName = stored.displayName;

    // Bash 工具的 intent 兜底：使用 description 字段
    if (!intent && toolBlock.name === 'Bash') {
      intent = (toolBlock.input as { description?: string }).description;
    }

    return { intent, displayName };
  }

  // 当 metadata store 未命中时打日志，便于排查跨进程同步问题
  const argsHasIntent = typeof toolBlock.input._intent === 'string';
  const argsHasDisplayName = typeof toolBlock.input._displayName === 'string';
  log.debug(
    `extractToolMetadata: store miss for ${toolBlock.name} (${toolBlock.id}); candidates=${Array.from(idCandidates).join(' -> ')}; argsIntent=${argsHasIntent}; argsDisplayName=${argsHasDisplayName}`,
  );

  // 2. 兜底：直接从工具 input 中读取（Codex 后端、非流式等场景）
  let intent = toolBlock.input._intent as string | undefined;
  const displayName = toolBlock.input._displayName as string | undefined;

  // 3. Bash 工具的 intent 兜底：使用 description 字段
  if (!intent && toolBlock.name === 'Bash') {
    intent = (toolBlock.input as { description?: string }).description;
  }

  return { intent, displayName };
}

/** 把工具结果值序列化为字符串，能安全处理循环引用（类比 Go 中安全 JSON marshal） */
export function serializeResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // 序列化失败（例如含循环引用、函数、BigInt 等）时返回兜底文案
    return '[Result contains non-serializable data]';
  }
}

/** 判断工具结果是否表示一次错误 */
export function isToolResultError(result: unknown): boolean {
  if (typeof result === 'string') {
    // 字符串结果中匹配常见错误前缀
    return /^\s*(\[ERROR\]|Error:|error:)/.test(result);
  }
  if (result && typeof result === 'object') {
    // 对象结果中检查显式的错误标志字段
    if ('is_error' in result && (result as { is_error: boolean }).is_error) return true;
    if ('error' in result) return true;
  }
  return false;
}

/**
 * 从工具结果中识别「后台任务 / 后台 shell」相关事件。
 * 返回的事件会被并入外层事件流，供 UI 展示后台运行状态。
 */
function detectBackgroundEvents(
  toolUseId: string,
  entry: ToolEntry,
  resultStr: string,
  isError: boolean,
  turnId?: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  // 后台 Task 检测：Task/Agent 工具，且结果中带 agentId。
  //
  // 两种启动形态都会产生一个真正的后台 agent：
  //  1. 工具 input 中显式设置 `run_in_background: true`。
  //  2. 默认异步：SDK 自动把 Agent/Task 转入后台并返回一个启动确认，调用方从未设置
  //     `run_in_background`。该结果有一个独特的签名——`agentId:` 加上 "working in
  //     the background" / `output_file:` / "Async agent launched"——让我们能安全地检测到它。
  //
  // 签名要求正是防止误判的关键：一个*前台* Agent 如果其结果文本只是恰好提到了
  // "agentId:"（比如引用了它找到的某个值），既没有后台措辞也没有 output_file，
  // 因此不会被标记为后台。这与渲染器 App.tsx 中的签名检查（`isBackgroundingResult`）
  // 保持一致。对这两种形态，最终都会收到一个真实的 task_completed 通知；
  // WS3 注册表 + turn 结束时的孤儿兜底机制覆盖了收不到通知的情况。
  const wasRunInBackground = entry.input?.run_in_background === true;
  const looksAsyncLaunched =
    /agentId:\s*[a-zA-Z0-9_-]+/.test(resultStr) &&
    (/working in the background/i.test(resultStr) ||
      /output_file:/i.test(resultStr) ||
      /async agent launched/i.test(resultStr));
  if (isParentTaskTool(entry.name) && (wasRunInBackground || looksAsyncLaunched) && !isError && resultStr) {
    const agentIdMatch = resultStr.match(/agentId:\s*([a-zA-Z0-9_-]+)/);
    if (agentIdMatch?.[1]) {
      // Prefer explicit `_intent` metadata; the built-in Agent/Task tool doesn't
      // set it, so fall back to its concise `description` param (the "3-5 word
      // description of the task") — this is what the chip shows instead of the
      // opaque agent ID. Mirrors the Bash background-shell path below.
      const intentValue = (typeof entry.input._intent === 'string' && entry.input._intent)
        || (typeof entry.input.description === 'string' && entry.input.description)
        || undefined;
      events.push({
        type: 'task_backgrounded',
        toolUseId,
        taskId: agentIdMatch[1],
        turnId,
        ...(intentValue && { intent: intentValue }),
      });
    }
  }

  // 后台 Shell 检测：Bash 工具，且结果中带 shell_id 或 backgroundTaskId
  if (entry.name === 'Bash' && !isError && resultStr) {
    const shellIdMatch = resultStr.match(/shell_id:\s*([a-zA-Z0-9_-]+)/)
      || resultStr.match(/"backgroundTaskId":\s*"([a-zA-Z0-9_-]+)"/);
    if (shellIdMatch?.[1]) {
      // intent 兜底到 description，再兜底到 undefined
      const intentValue = (typeof entry.input._intent === 'string' && entry.input._intent)
        || (typeof entry.input.description === 'string' && entry.input.description)
        || undefined;
      const commandValue = typeof entry.input.command === 'string' ? entry.input.command : undefined;
      events.push({
        type: 'shell_backgrounded',
        toolUseId,
        shellId: shellIdMatch[1],
        turnId,
        ...(intentValue && { intent: intentValue }),
        ...(commandValue && { command: commandValue }),
      });
    }
  }

  // 后台 Workflow 检测：Workflow 工具总是在后台启动并立即返回。它的结果有独特签名：
  //   "Workflow launched in background. Task ID: <id>\nSummary: <...>\nTranscript
  //    dir: .../workflows/wf_XXX"
  // 它不是 parent-task 工具，且其结果缺少 async-agent 签名（agentId/output_file），
  // 因此需要自己的检测器。我们把它作为 kind 为 'workflow' 的后台任务上报，
  // 附带 workflow 运行 id（wf_XXX，从 transcript dir 解析），这样 SubagentStop 事件
  // 就能把已完成的 agent 归因到这个 chip（见 parseWorkflowIdFromTranscriptPath）。
  if (entry.name === 'Workflow' && !isError && resultStr) {
    const taskIdMatch = resultStr.match(/Workflow launched in background\.?\s*Task ID:\s*(\S+)/i);
    if (taskIdMatch?.[1]) {
      const summaryMatch = resultStr.match(/Summary:\s*(.+)/);
      const workflowId = parseWorkflowIdFromTranscriptPath(resultStr);
      const intentValue = (typeof entry.input._intent === 'string' && entry.input._intent)
        || (summaryMatch?.[1]?.trim())
        || undefined;
      events.push({
        type: 'task_backgrounded',
        toolUseId,
        taskId: taskIdMatch[1],
        turnId,
        kind: 'workflow',
        ...(intentValue && { intent: intentValue }),
        ...(workflowId && { workflowId }),
      });
    }
  }

  // Shell 被杀检测：KillShell 工具
  if (entry.name === 'KillShell') {
    const shellId = entry.input.shell_id as string;
    if (shellId) {
      events.push({
        type: 'shell_killed',
        shellId,
        turnId,
      });
    }
  }

  return events;
}
