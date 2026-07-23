/**
 * turn-utils.ts
 *
 * 用于按 turn 分组消息以供 TurnCard 渲染的工具函数。
 * 将扁平的 Message[] 数组转换为分组的 turn，以实现类邮件展示。
 */

import type { Message, StoredMessage, MessageRole } from '@craft-agent/core'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { storedToMessage } from '@craft-agent/core'

export { storedToMessage }
import type { ActivityItem, ActivityStatus, ActivityType, ResponseContent, TodoItem } from './TurnCard'

// 为消费者重新导出 ActivityItem
export type { ActivityItem }

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从工具错误消息中剥离错误包装标签和前缀。
 * Claude Agent SDK 将错误包装在 <error><tool_use_error>...</tool_use_error></error>
 * 等标签中，对用户不友好。此外 errorResponse() 和 blockWithReason() 会给消息
 * 加上 "[ERROR] " 前缀，以便 Codex 模型检测失败（OpenAI API 没有错误信号字段）。
 * 我们在这里剥离该前缀以获得干净的 UI 展示。
 */
function stripErrorTags(content: string | undefined): string | undefined {
  if (!content) return content
  return content
    .replace(/<\/?error>/gi, '')
    .replace(/<\/?tool_use_error>/gi, '')
    .replace(/^\[ERROR]\s*/i, '')
    .trim()
}

// ============================================================================
// 类型
// ============================================================================

/** 表示一个完整的助手 turn */
export interface AssistantTurn {
  type: 'assistant'
  turnId: string
  activities: ActivityItem[]
  response?: ResponseContent
  intent?: string
  isStreaming: boolean
  isComplete: boolean
  timestamp: number
  /** 从 TodoWrite 工具提取——该 turn 中的最新 todo 状态 */
  todos?: TodoItem[]
}

/** 表示一条用户消息 */
export interface UserTurn {
  type: 'user'
  message: Message
  timestamp: number
}

/** 表示一条独立的 system/info/error 消息 */
export interface SystemTurn {
  type: 'system'
  message: Message
  timestamp: number
}

/** 表示一个认证请求（凭证输入、OAuth 流程） */
export interface AuthRequestTurn {
  type: 'auth-request'
  message: Message
  timestamp: number
}

export type Turn = AssistantTurn | UserTurn | SystemTurn | AuthRequestTurn

/**
 * 为助手 turn 卡片构建稳定的 UI 身份键。
 *
 * 存在原因：
 * - 后端 turnId 可能被视觉上拆分的多个助手卡片复用
 *   （例如 steer/中断边界）。
 * - 展开状态必须以 UI 卡片身份为键，而非原始后端 turnId。
 */
export function getAssistantTurnUiKey(turn: AssistantTurn, index: number): string {
  if (turn.response?.messageId) {
    return `assistant:msg:${turn.response.messageId}`
  }
  return `assistant:turn:${turn.turnId}:${turn.timestamp}:${index}`
}

// ============================================================================
// Turn 生命周期阶段
// ============================================================================

/**
 * TurnPhase 表示助手 turn 的当前生命周期状态。
 *
 * 状态机：
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  PENDING ──(tool_start)──► TOOL_ACTIVE ──(all_tools_done)──► AWAITING      │
 * │     │                          │                                  │        │
 * │     │ text_delta               │ text_delta                       │        │
 * │     ▼                          ▼                                  │        │
 * │  STREAMING ◄───────────── STREAMING (intermediate) ◄──────────────┘        │
 * │     │                          │                                           │
 * │     │ text_complete            │ text_complete + more work coming          │
 * │     ▼                          ▼                                           │
 * │  COMPLETE                   AWAITING                                       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * 关键洞察："awaiting" 阶段是工具完成到下一个动作之间的间隙。
 * 此前这个状态不可见，导致 turn 卡片在工具完成后"消失"。
 */
export type TurnPhase =
  | 'pending'      // turn 已创建，等待第一个 activity
  | 'tool_active'  // 至少有一个工具正在运行
  | 'awaiting'     // 所有工具完成，等待下一个动作（间隙！）
  | 'streaming'    // 最终响应文本正在流式输出
  | 'complete'     // turn 已完成

/**
 * 从 turn 数据推导当前阶段。
 *
 * 这是一个纯函数，检查 turn 状态以确定阶段。
 * 阶段是推导出来的（而非追踪），使其可测试且一致。
 *
 * 优先级顺序（首个匹配生效）：
 * 1. complete - turn.isComplete 为 true
 * 2. streaming - 响应存在且正在流式输出（最终响应）
 * 3. tool_active - 任意 TOOL activity 状态为 'running'
 * 4. awaiting - 有 activity 但无工具运行（间隙！）
 * 5. pending - 尚无 activity
 *
 * 注意：仅 `type: 'tool'` 的 activity 计入 tool_active 阶段。
 * 中间文本（type: 'intermediate'）和状态为 'running' 的状态 activity（type: 'status'）
 * 不会触发 tool_active——它们展示 "Thinking..."。
 */
export function deriveTurnPhase(turn: AssistantTurn): TurnPhase {
  // complete 优先——turn 确定已完成
  if (turn.isComplete) {
    return 'complete'
  }

  // 检查最终响应是否正在流式输出
  // 注意：turn.response 仅存在于最终响应，不含中间文本
  if (turn.response && turn.response.isStreaming) {
    return 'streaming'
  }

  // 检查是否有 TOOL activity 正在运行。
  // 仅 tool 类型 activity 计入——中间文本和状态为 'running' 的状态 activity
  // 应展示 "Thinking..."，而非工具 spinner。
  const hasRunningTools = turn.activities.some(a => a.type === 'tool' && a.status === 'running')
  if (hasRunningTools) {
    return 'tool_active'
  }

  // 有 activity 但无运行中 = "间隙"状态
  // 这是此前未被表示的关键状态，导致 UI 在工具完成后隐藏 turn 卡片。
  if (turn.activities.length > 0) {
    return 'awaiting'
  }

  // 尚无 activity——turn 等待首个动作
  return 'pending'
}

/**
 * 判断是否应展示 "Thinking..." 指示器。
 *
 * 当 turn 活跃但没有可见内容展示给用户时（无运行中工具、无流式响应），
 * 显示思考指示器。这覆盖了初始 pending 状态和工具完成后的间隙。
 *
 * @param phase - 当前 turn 阶段
 * @param isBuffering - 响应文本是否仍在缓冲
 */
export function shouldShowThinkingIndicator(phase: TurnPhase, isBuffering: boolean): boolean {
  // 在以下情况展示思考指示器：
  // - pending：等待第一个 activity
  // - awaiting：工具完成到下一个动作的间隙
  // - streaming 但缓冲中：文本已开始但未准备好展示
  return phase === 'pending' || phase === 'awaiting' || (phase === 'streaming' && isBuffering)
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 将消息中的工具状态转换为 ActivityStatus */
function getToolStatus(message: Message): ActivityStatus {
  // response_too_large 视为成功（数据已保存，仅过大无法内联展示）
  if (message.errorCode === 'response_too_large') return 'completed'
  if (message.isError) return 'error'
  // backgrounded 优先——tool_result 在 task_backgrounded 之前到达，
  // 因此 toolResult 已设置但任务仍在后台运行
  if (message.toolStatus === 'backgrounded') return 'backgrounded'
  // 先检查显式 toolStatus（由 tool_result 处理器设置）
  if (message.toolStatus === 'completed') return 'completed'
  // 兜底：检查 toolResult 是否存在（处理空字符串结果）
  if (message.toolResult !== undefined) return 'completed'
  if (message.toolStatus === 'pending') return 'pending'
  return 'running'
}

/**
 * 将消息转换为 ActivityItem，并增量计算深度。
 * 深度使用已有 activity 立即计算，使流式输出期间也能正确渲染树状视图
 * （而非仅在 flush 时）。
 *
 * @param message - 要转换的消息
 * @param existingActivities - turn 中已有的 activity（用于深度查找）
 */
function messageToActivity(message: Message, existingActivities: ActivityItem[] = []): ActivityItem {
  const activity: ActivityItem = {
    id: message.id,
    type: 'tool' as ActivityType,
    status: getToolStatus(message),
    toolName: message.toolName,
    toolUseId: message.toolUseId,  // 用于父子匹配
    toolInput: message.toolInput,
    content: message.toolResult || message.content,
    intent: message.toolIntent,
    displayName: message.toolDisplayName,  // LLM 生成的人类友好名称
    toolDisplayMeta: message.toolDisplayMeta,  // 嵌入的元数据，含 base64 图标，兼容 viewer
    timestamp: message.timestamp,
    error: message.isError ? stripErrorTags(message.toolResult || message.content) : undefined,
    // parentId：父工具（例如 Task 子代理）的 toolUseId。
    // 由 session manager 的 parentToolStack 追踪，而非 SDK 的
    // parent_tool_use_id（后者用于结果匹配，非层级关系）。
    parentId: message.parentToolUseId,
    // 后台任务字段
    taskId: message.taskId,
    shellId: message.shellId,
    elapsedSeconds: message.elapsedSeconds,
    isBackground: message.isBackground,
  }

  // 使用已有 activity 增量计算深度
  // 这使流式输出期间也能正确渲染树状视图
  if (activity.parentId) {
    const parent = existingActivities.find(a => a.toolUseId === activity.parentId)
    activity.depth = parent ? (parent.depth || 0) + 1 : 1
  } else {
    activity.depth = 0
  }

  return activity
}

/**
 * 根据父子关系计算 activity 的嵌套深度。
 * 原地修改 activity，添加 depth 字段（0 = 根，1 = 子，依此类推）
 *
 * 注意：有了 messageToActivity() 的增量深度计算后，此函数
 * 作为边界情况的兜底（例如父项在子项之后到达），
 * 确保 turn flush 时所有深度都正确设置。
 */
function calculateActivityDepths(activities: ActivityItem[]): void {
  // 构建 toolUseId -> activity 的映射以便快速查找父项
  const toolIdToActivity = new Map<string, ActivityItem>()
  for (const activity of activities) {
    if (activity.toolUseId) {
      toolIdToActivity.set(activity.toolUseId, activity)
    }
  }

  // 为每个 activity 计算深度（重新计算以处理边界情况）
  for (const activity of activities) {
    let depth = 0
    let parentId = activity.parentId

    // 沿父链向上遍历，最多 10 层以防止无限循环
    while (parentId && depth < 10) {
      depth++
      const parent = toolIdToActivity.get(parentId)
      parentId = parent?.parentId
    }

    activity.depth = depth
  }
}

// ============================================================================
// TodoWrite 提取
// ============================================================================

/**
 * 从 activity 中的 TodoWrite 工具结果提取 todos。
 * 返回最新 todo 状态（来自最近一次 TodoWrite 调用）。
 */
function extractTodosFromActivities(activities: ActivityItem[]): TodoItem[] | undefined {
  // 查找所有 TodoWrite 工具结果，取最新一个
  const todoWriteActivities = activities
    .filter(a => a.toolName === 'TodoWrite' && a.status === 'completed' && a.content)
    .sort((a, b) => b.timestamp - a.timestamp) // 最新的在前

  const latestActivity = todoWriteActivities[0]
  if (!latestActivity) return undefined

  const latestResult = latestActivity.content
  if (!latestResult) return undefined

  try {
    // TodoWrite 结果通常是成功消息，但 input 中包含 todos
    // 我们需要获取 toolInput，其中包含 todos 数组
    const input = latestActivity.toolInput
    if (input && Array.isArray(input.todos)) {
      return input.todos.map((todo: { content: string; status: string; activeForm?: string }) => ({
        content: todo.content,
        status: todo.status as 'pending' | 'in_progress' | 'completed',
        activeForm: todo.activeForm,
      }))
    }
  } catch {
    // 解析失败，返回 undefined
  }

  return undefined
}

// ============================================================================
// 主分组函数
// ============================================================================

export interface GroupTurnsOptions {
  /**
   * 会话是否仍在活跃处理。
   *
   * 为 `false` 时，开放 turn（若有 activity）会在最终 flush 前标记为完成，
   * 这样既有的"将最后中间文本提升为响应"分支会触发，
   * 避免当 turn 在工具调用结束且无非中间 `text_complete` 时聊天永远停在 "Thinking…"。
   *
   * 对应 messaging-gateway/renderer.ts 的 lastAssistantText 兜底。
   */
  isSessionProcessing?: boolean
}

/**
 * 将消息分组为 turn 以供 TurnCard 渲染
 *
 * 规则：
 * - 用户消息 flush 当前 turn 并开始全新上下文
 * - 工具消息 + 中间助手消息属于当前 turn
 * - 最终助手消息（非流式、非中间）flush turn
 * - error/status/info 消息是独立的 system turn
 *
 * 注意：我们有意忽略 turnId 进行分组。SDK 为每条 API 消息生成新的
 * turnId，但从用户角度，用户消息到最终响应之间的所有工作应是同一个 turn。
 * 我们用 isIntermediate 作为信号：isIntermediate=true 表示还有更多工作，
 * isIntermediate=false 表示最终响应。
 */
export function groupMessagesByTurn(messages: Message[], options: GroupTurnsOptions = {}): Turn[] {
  // 分组前丢弃隐藏消息。这些是系统生成的 nudge，必须送达模型（它们驱动一个 turn）
  // 但绝不能渲染为气泡——例如唤醒空闲会话的 WS2 后台任务完成 nudge。
  // 它们触发的助手响应有自己的 turnId，仍正常渲染。
  const visibleMessages = messages.filter(m => !m.hidden)
  // 按时间戳排序以获得正确时序
  // 这确保即使流式输出期间消息乱序到达也能正确分组
  const sortedMessages = [...visibleMessages].sort((a, b) => a.timestamp - b.timestamp)

  const turns: Turn[] = []
  let currentTurn: AssistantTurn | null = null

  const flushCurrentTurn = (interrupted = false) => {
    if (currentTurn) {
      // 按时间戳排序 activity 以确保正确时序
      // 这是必要的，因为缓冲可能延迟消息加入数组的时机，
      // 导致评论出现在较晚启动的工具之后
      currentTurn.activities.sort((a, b) => a.timestamp - b.timestamp)

      // 计算父子工具关系的嵌套深度
      calculateActivityDepths(currentTurn.activities)

      // 从 TodoWrite 工具结果提取 todos
      currentTurn.todos = extractTodosFromActivities(currentTurn.activities)

      // 若被中断，将运行中的 activity 标记为 error，todos 标记为 interrupted
      if (interrupted) {
        currentTurn.activities = currentTurn.activities.map(activity =>
          activity.status === 'running'
            ? { ...activity, status: 'error' as ActivityStatus, error: 'Interrupted' }
            : activity
        )
        if (currentTurn.todos) {
          currentTurn.todos = currentTurn.todos.map(todo =>
            todo.status === 'in_progress'
              ? { ...todo, status: 'interrupted' as const }
              : todo
          )
        }
        currentTurn.isStreaming = false
        currentTurn.isComplete = true
      }

      // 若无响应但有中间文本，将最后一条提升为响应
      // 被中断的 turn 不这样做——尊重用户中断
      // 含 plan 的 turn 不这样做——plan 就是最终输出
      // 仅在 turn 完成时提升（处理指示器隐藏）
      const hasPlan = currentTurn.activities.some(a => a.type === 'plan')
      if (!interrupted && !hasPlan && !currentTurn.response && currentTurn.isComplete && currentTurn.activities.length > 0) {
        // 查找最后一条中间文本 activity（倒序取最新）
        const lastTextActivity = [...currentTurn.activities]
          .reverse()
          .find(a => a.type === 'intermediate' && a.content)

        if (lastTextActivity?.content) {
          currentTurn.response = {
            text: lastTextActivity.content,
            isStreaming: false,
            messageId: lastTextActivity.id,
          }
        }
      }

      turns.push(currentTurn)
      currentTurn = null
    }
  }

  for (const message of sortedMessages) {
    // auth-request 消息是独立 turn（凭证输入、OAuth 流程）
    if (message.role === 'auth-request') {
      // 若有当前 turn，它已完成（后面有内容跟随）
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'auth-request',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // 用户消息自成独立 turn
    if (message.role === 'user') {
      // 若有当前 turn，它已完成（后面有内容跟随）
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'user',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // 状态消息变为当前 turn 内的 activity（不中断 turn）
    if (message.role === 'status') {
      if (!currentTurn) {
        // 为此状态消息开启新 turn
        currentTurn = {
          type: 'assistant',
          turnId: message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: true,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      const statusActivity: ActivityItem = {
        id: message.id,
        type: 'status',
        status: 'running',
        content: message.content,
        timestamp: message.timestamp,
        statusType: message.statusType,
        depth: 0,
      }
      currentTurn.activities.push(statusActivity)
      continue
    }

    // compaction_complete 的 info 消息更新匹配的状态 activity
    if (message.role === 'info' && message.statusType === 'compaction_complete') {
      if (currentTurn) {
        const statusIdx = currentTurn.activities.findIndex(
          a => a.type === 'status' && a.statusType === 'compacting'
        )
        const existingActivity = currentTurn.activities[statusIdx]
        if (statusIdx !== -1 && existingActivity) {
          currentTurn.activities[statusIdx] = {
            ...existingActivity,
            status: 'completed',
            content: message.content,
          }
        }
      }
      continue  // 不创建独立 system turn
    }

    // error/info/warning 消息是独立的
    if (message.role === 'error' || message.role === 'info' || message.role === 'warning') {
      // 先 flush 当前 turn（info 消息标记为中断）
      const isInterruption = message.role === 'info'
      // 对于 error/warning（非 info），前一个 turn 已完成
      if (currentTurn && !isInterruption) currentTurn.isComplete = true
      flushCurrentTurn(isInterruption)
      turns.push({
        type: 'system',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // plan 消息作为 activity 加入，以便与工具调用按时间排序
    // 这确保 SubmitPlan 工具在时间上出现在 plan 内容之前
    if (message.role === 'plan') {
      if (!currentTurn) {
        // 边界情况：plan 之前没有 activity
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: false,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // 将 plan 作为 activity 加入，使其与其他 activity 按时间排序
      currentTurn.activities.push({
        id: message.id,
        type: 'plan' as ActivityType,
        status: 'completed',
        content: message.content,
        messageId: message.id,
        annotations: message.annotations,
        displayName: 'Plan',
        timestamp: message.timestamp,
      })
      currentTurn.isStreaming = false
      currentTurn.isComplete = true
      flushCurrentTurn()
      continue
    }

    // 工具消息属于当前助手 turn
    if (message.role === 'tool') {
      // 工具完成条件：toolStatus 为 'completed' 或 toolResult 存在（但 backgrounded 除外）
      const isToolComplete = (message.toolStatus === 'completed' || message.toolResult !== undefined) && message.toolStatus !== 'backgrounded'
      if (!currentTurn) {
        // 开启新 turn
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: message.toolIntent,
          isStreaming: !isToolComplete,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // 总是加入当前 turn（忽略 turnId 差异）
      // 传入已有 activity 以便增量计算深度
      currentTurn.activities.push(messageToActivity(message, currentTurn.activities))
      currentTurn.isStreaming = !isToolComplete
      continue
    }

    // 助手消息是 turn 的响应部分
    if (message.role === 'assistant') {
      // 中间消息或 pending 消息（尚不确定）是 activity，非响应
      // pending：流式文本，尚不知是否中间——视为中间，
      // 直到 text_complete 携带确定的 isIntermediate 标志到达
      if (message.isIntermediate || message.isPending) {
        if (!currentTurn) {
          // 为此中间消息开启新 turn
          currentTurn = {
            type: 'assistant',
            turnId: message.turnId || message.id,
            activities: [],
            response: undefined,
            intent: undefined,
            isStreaming: !!message.isPending,
            isComplete: false,
            timestamp: message.timestamp,
          }
        }
        // 总是作为 activity 加入当前 turn（忽略 turnId 差异）
        // pending 消息在确认完成前展示为 'running'
        // 为中间消息包含 parentId 以支持子代理内嵌套
        const intermediateActivity: ActivityItem = {
          id: message.id,
          type: 'intermediate',
          status: message.isPending ? 'running' : 'completed',
          content: message.content,
          timestamp: message.timestamp,
          parentId: message.parentToolUseId,
        }
        // 也为中间消息计算深度
        if (intermediateActivity.parentId) {
          const parent = currentTurn.activities.find(a => a.toolUseId === intermediateActivity.parentId)
          intermediateActivity.depth = parent ? (parent.depth || 0) + 1 : 1
        } else {
          intermediateActivity.depth = 0
        }
        currentTurn.activities.push(intermediateActivity)

        // 根据此消息更新 turn 流式状态
        // 若消息不再 pending/流式，相应更新 turn 状态
        if (!message.isPending && !message.isStreaming) {
          currentTurn.isStreaming = false
        }
        continue
      }

      // 非中间助手消息 = 最终响应
      if (!currentTurn) {
        // 这是仅含响应的 turn（无工具）
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: !!message.isStreaming,
          isComplete: !message.isStreaming,
          timestamp: message.timestamp,
        }
      }

      // 设为当前 turn 的响应（忽略 turnId 差异）
      currentTurn.response = {
        text: message.content,
        isStreaming: !!message.isStreaming,
        streamStartTime: message.isStreaming ? message.timestamp : undefined,
        messageId: message.id,
        annotations: message.annotations,
      }
      currentTurn.isStreaming = !!message.isStreaming
      currentTurn.isComplete = !message.isStreaming

      // turn 完成时 flush（非流式 = 收到最终响应）
      if (!message.isStreaming) {
        flushCurrentTurn()
      }
      continue
    }
  }

  // 会话完成兜底（对应 messaging-gateway/renderer.ts 的 lastAssistantText 兜底）。
  // 当会话停止处理且开放 turn 有 activity 但从未收到非中间助手最终响应时，
  // 标记为完成，使 flushCurrentTurn 中既有的"将最后中间文本提升为响应"分支触发。
  // 没有这个兜底，当 turn 在工具调用结束时聊天会永远停在 "Thinking…"。
  if (
    options.isSessionProcessing === false
    && currentTurn
    && (currentTurn as AssistantTurn).activities.length > 0
  ) {
    (currentTurn as AssistantTurn).isComplete = true
  }

  // flush 剩余 turn
  flushCurrentTurn()

  return turns
}

/**
 * 获取 turn 的主要 intent（activity 中首个可用 intent）
 */
export function getTurnIntent(turn: AssistantTurn): string | undefined {
  // 先检查显式 turn intent
  if (turn.intent) return turn.intent

  // 再查找 activity intent
  for (const activity of turn.activities) {
    if (activity.intent) return activity.intent
  }

  return undefined
}

/**
 * 检查 turn 中是否有 activity 仍在运行
 */
export function hasPendingActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'backgrounded')
}

/**
 * 检查 turn 中是否有 activity 出错
 */
export function hasErrorActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'error')
}

/**
 * 获取已完成 activity 的摘要
 */
export function getActivitySummary(turn: AssistantTurn): string {
  const completed = turn.activities.filter(a => a.status === 'completed').length
  const running = turn.activities.filter(a => a.status === 'running').length
  const errors = turn.activities.filter(a => a.status === 'error').length

  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (completed > 0) parts.push(`${completed} completed`)
  if (errors > 0) parts.push(`${errors} failed`)

  return parts.join(', ') || 'No activities'
}

/**
 * 将 AssistantTurn 格式化为 markdown 以便在 Monaco 中详细查看
 * 展示完整工具输入、结果和响应
 */
export function formatTurnAsMarkdown(turn: AssistantTurn): string {
  const lines: string[] = []

  // 若有 intent 则用作标题
  if (turn.intent) {
    lines.push(`# ${turn.intent}`)
  } else {
    lines.push('# Turn Details')
  }
  lines.push('')

  // 摘要
  const summary = getActivitySummary(turn)
  lines.push(`**Status:** ${turn.isComplete ? 'Complete' : 'In Progress'} · ${summary}`)
  lines.push('')

  // activity 区域
  if (turn.activities.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## Activities')
    lines.push('')

    for (const activity of turn.activities) {
      if (activity.type === 'intermediate') {
        // 中间文本（思考/评论）
        lines.push(`### 💭 Commentary`)
        lines.push('')
        if (activity.content) {
          lines.push(activity.content)
        }
        lines.push('')
      } else if (activity.toolName) {
        // 工具调用
        const statusEmoji = activity.status === 'completed' ? '✅' :
                           activity.status === 'error' ? '❌' :
                           activity.status === 'running' ? '⏳' : '⏸️'

        lines.push(`### ${statusEmoji} ${activity.toolName}`)
        lines.push('')

        // 若有 intent
        if (activity.intent) {
          lines.push(`> ${activity.intent}`)
          lines.push('')
        }

        // 输入
        if (activity.toolInput && Object.keys(activity.toolInput).length > 0) {
          lines.push('**Input:**')
          lines.push('```json')
          lines.push(JSON.stringify(activity.toolInput, null, 2))
          lines.push('```')
          lines.push('')
        }

        // 结果/输出
        if (activity.content) {
          lines.push('**Result:**')
          // 检查结果是否像 JSON
          const trimmed = activity.content.trim()
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(trimmed)
              lines.push('```json')
              lines.push(JSON.stringify(parsed, null, 2))
              lines.push('```')
            } catch {
              // 非有效 JSON，按文本展示
              lines.push('```')
              lines.push(activity.content)
              lines.push('```')
            }
          } else {
            lines.push('```')
            lines.push(activity.content)
            lines.push('```')
          }
          lines.push('')
        }

        // 若有错误
        if (activity.error) {
          lines.push('**Error:**')
          lines.push('```')
          lines.push(activity.error)
          lines.push('```')
          lines.push('')
        }
      }
    }
  }

  // 响应区域
  if (turn.response?.text) {
    lines.push('---')
    lines.push('')
    lines.push('## Response')
    lines.push('')
    lines.push(turn.response.text)
  }

  return lines.join('\n')
}

/**
 * 将单个 ActivityItem 格式化为 markdown 以便在 Monaco 中详细查看
 */
export function formatActivityAsMarkdown(activity: ActivityItem): string {
  const lines: string[] = []

  if (activity.type === 'intermediate') {
    // 评论/思考
    lines.push('# Commentary')
    lines.push('')
    if (activity.content) {
      lines.push(activity.content)
    }
    return lines.join('\n')
  }

  // 工具 activity
  const statusEmoji = activity.status === 'completed' ? '✅' :
                     activity.status === 'error' ? '❌' :
                     activity.status === 'running' ? '⏳' : '⏸️'

  lines.push(`# ${statusEmoji} ${activity.toolName || 'Tool'}`)
  lines.push('')

  // 若有 intent
  if (activity.intent) {
    lines.push(`> ${activity.intent}`)
    lines.push('')
  }

  // 输入
  if (activity.toolInput && Object.keys(activity.toolInput).length > 0) {
    lines.push('## Input')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(activity.toolInput, null, 2))
    lines.push('```')
    lines.push('')
  }

  // 结果/输出
  if (activity.content) {
    lines.push('## Result')
    lines.push('')
    // 检查结果是否像 JSON
    const trimmed = activity.content.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        lines.push('```json')
        lines.push(JSON.stringify(parsed, null, 2))
        lines.push('```')
      } catch {
        // 非有效 JSON，按文本展示
        lines.push('```')
        lines.push(activity.content)
        lines.push('```')
      }
    } else {
      lines.push('```')
      lines.push(activity.content)
      lines.push('```')
    }
    lines.push('')
  }

  // 若有错误
  if (activity.error) {
    lines.push('## Error')
    lines.push('')
    lines.push('```')
    lines.push(activity.error)
    lines.push('```')
  }

  return lines.join('\n')
}

// ============================================================================
// 末位 turn/消息工具函数
// ============================================================================

/**
 * 从 turn 列表中获取最后一个助手 turn。
 * 用于确定当前/最近的助手响应。
 */
export function getLastAssistantTurn(turns: Turn[]): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'assistant') {
      return turn as AssistantTurn
    }
  }
  return undefined
}

/**
 * 从 turn 中获取最后一条用户消息的时间戳。
 * 用于计算用户发送消息以来的已用时间。
 */
export function getLastUserMessageTime(turns: Turn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'user') {
      return (turn as UserTurn).timestamp
    }
  }
  return undefined
}

/**
 * 检查最后一个助手 turn 是否仍在流式输出/处理。
 */
export function isLastTurnStreaming(turns: Turn[]): boolean {
  const lastAssistant = getLastAssistantTurn(turns)
  return lastAssistant?.isStreaming ?? false
}

/**
 * 预计算哪些 activity 是其深度层级的末位子项。
 * 返回末位子项 activity ID 的 Set。
 * 这是 O(n) 而非渲染时检查的 O(n²)。
 */
export function computeLastChildSet(activities: ActivityItem[]): Set<string> {
  // 跟踪每个 parentId 的最后 activity
  const lastByParent = new Map<string | undefined, string>()

  for (const activity of activities) {
    if (activity.depth && activity.depth > 0) {
      // 此 activity 有父项——标记为（可能的）末位子项
      lastByParent.set(activity.parentId, activity.id)
    }
  }

  return new Set(lastByParent.values())
}

// ============================================================================
// 格式化辅助函数
// ============================================================================

/**
 * 将毫秒时长格式化为人类可读字符串。
 * @example formatDuration(1234) => "1.2s"
 * @example formatDuration(65000) => "1m 5s"
 * @example formatDuration(125000) => "2m+"
 */
export function formatDuration(ms: number): string {
  // 防御非法输入
  if (!Number.isFinite(ms) || ms < 0) {
    return '--'
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (minutes >= 2) {
    return `${minutes}m+`
  }
  return `${minutes}m ${remainingSeconds}s`
}

/**
 * 将 token 数量格式化为人类可读字符串。
 * @example formatTokens(500) => "500"
 * @example formatTokens(1500) => "1.5k"
 * @example formatTokens(15000) => "15k"
 */
export function formatTokens(count: number): string {
  // 防御非法输入
  if (!Number.isFinite(count) || count < 0) {
    return '0'
  }
  count = Math.floor(count) // token 为整数
  if (count < 1000) {
    return count.toString()
  }
  const k = count / 1000
  if (k < 10) {
    return `${k.toFixed(1)}k`
  }
  return `${Math.round(k)}k`
}

// ============================================================================
// Task 子代理的 activity 分组
// ============================================================================

/**
 * 从 TaskOutput 工具结果提取的数据
 */
export interface TaskOutputData {
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
}

/**
 * 表示一个 Task 工具及其分组的子 activity
 */
export interface ActivityGroup {
  type: 'group'
  parent: ActivityItem
  children: ActivityItem[]
  /** 来自 TaskOutput 结果的数据（耗时、token） */
  taskOutputData?: TaskOutputData
}

/**
 * 类型守卫，判断项是否为 ActivityGroup
 */
export function isActivityGroup(item: ActivityItem | ActivityGroup): item is ActivityGroup {
  return 'type' in item && item.type === 'group' && 'parent' in item && 'children' in item
}

/**
 * 从 activity 的结果内容提取 TaskOutput 数据。
 * TaskOutput 结果是 JSON，包含：result、usage、total_cost_usd、duration_ms
 */
function extractTaskOutputData(activity: ActivityItem): TaskOutputData | undefined {
  if (!activity.content) return undefined

  try {
    const parsed = JSON.parse(activity.content)
    const data: TaskOutputData = {}

    if (typeof parsed.duration_ms === 'number') {
      data.durationMs = parsed.duration_ms
    }

    if (parsed.usage) {
      if (typeof parsed.usage.input_tokens === 'number') {
        data.inputTokens = parsed.usage.input_tokens
      }
      if (typeof parsed.usage.output_tokens === 'number') {
        data.outputTokens = parsed.usage.output_tokens
      }
    }

    // 仅在有数据时返回
    if (data.durationMs !== undefined || data.inputTokens !== undefined || data.outputTokens !== undefined) {
      return data
    }
  } catch {
    // 非有效 JSON 或缺少字段
  }

  return undefined
}

/**
 * 按父级 Task 工具分组 activity。
 *
 * 这将扁平的时序列表转换为分组结构：
 * - 保持顶层项（孤儿和 Task 分组）的时序
 * - 每个 Task 工具成为包含其子 activity 的分组
 * - 保持每个分组内的时序
 * - TaskOutput activity 被隐藏，但其数据丰富父级 Task
 *
 * @param activities - 按时间戳排序的扁平 activity 列表
 * @returns 独立 activity 和 activity 分组的混合数组
 */
export function groupActivitiesByParent(
  activities: ActivityItem[]
): (ActivityItem | ActivityGroup)[] {
  // 首先，构建有效 Task toolUseId 的集合（实际存在的父项）
  const taskToolUseIds = new Set<string>()
  for (const activity of activities) {
    if (isParentTaskTool(activity.toolName ?? '') && activity.toolUseId) {
      taskToolUseIds.add(activity.toolUseId)
    }
  }

  // 构建 parentId -> 子项的映射以便高效查找
  // 仅包含父级 Task 实际存在的子项
  const childrenByParent = new Map<string, ActivityItem[]>()
  for (const activity of activities) {
    if (activity.parentId && taskToolUseIds.has(activity.parentId)) {
      const existing = childrenByParent.get(activity.parentId) || []
      existing.push(activity)
      childrenByParent.set(activity.parentId, existing)
    }
  }

  // 构建要跳过的子项 activity ID 集合（它们已包含在父项分组中）
  // parentId 指向不存在父项的 activity 不在此处加入，
  // 因此它们会作为孤儿 activity 出现在根级而非被丢弃
  const childIds = new Set<string>()
  for (const children of childrenByParent.values()) {
    for (const child of children) {
      childIds.add(child.id)
    }
  }

  // 构建 task_id（agent ID）-> TaskOutput 数据的映射
  // TaskOutput.toolInput.task_id 包含 Task 后台运行时返回的 agent ID
  const taskOutputByAgentId = new Map<string, TaskOutputData>()
  for (const activity of activities) {
    if (activity.toolName === 'TaskOutput' && activity.status === 'completed') {
      const taskId = activity.toolInput?.task_id as string | undefined
      if (taskId) {
        const data = extractTaskOutputData(activity)
        if (data) {
          taskOutputByAgentId.set(taskId, data)
        }
      }
    }
  }

  // 构建 Task toolUseId -> agent ID 的映射（从 Task 结果内容提取）
  // 当 Task 以 run_in_background: true 运行时，结果包含 "agentId: xyz"
  const taskToAgentId = new Map<string, string>()
  for (const activity of activities) {
    if (isParentTaskTool(activity.toolName ?? '') && (activity.status === 'completed' || activity.status === 'backgrounded') && activity.content) {
      // 从 Task 结果解析 agent ID——查找 "agentId: xyz" 模式
      const agentIdMatch = activity.content.match(/agentId:\s*([a-zA-Z0-9_-]+)/)
      const capturedAgentId = agentIdMatch?.[1]
      if (capturedAgentId && activity.toolUseId) {
        taskToAgentId.set(activity.toolUseId, capturedAgentId)
      }
    }
  }

  // 构建分组结果，保持时序
  const result: (ActivityItem | ActivityGroup)[] = []

  for (const activity of activities) {
    // 跳过作为 Task 子项的 activity（它们在父项分组中）
    if (childIds.has(activity.id)) {
      continue
    }

    // 跳过 TaskOutput activity——它们的数据已附加到父级 Task 分组
    if (activity.toolName === 'TaskOutput') {
      continue
    }

    // Task/Agent 工具成为带子项的分组
    if (isParentTaskTool(activity.toolName ?? '')) {
      const children = activity.toolUseId
        ? (childrenByParent.get(activity.toolUseId) || [])
        : []

      // 通过 agent ID 链查找此 Task 的 TaskOutput 数据：
      // Task.toolUseId -> agentId -> TaskOutput 数据
      let taskOutputData: TaskOutputData | undefined
      if (activity.toolUseId) {
        const agentId = taskToAgentId.get(activity.toolUseId)
        if (agentId) {
          taskOutputData = taskOutputByAgentId.get(agentId)
        }
      }

      result.push({
        type: 'group',
        parent: activity,
        children: children.sort((a, b) => a.timestamp - b.timestamp),
        taskOutputData,
      })
    } else {
      // 孤儿 activity——直接加入
      result.push(activity)
    }
  }

  return result
}

/**
 * 统计 activity 总数，包括分组内的
 */
export function countTotalActivities(items: (ActivityItem | ActivityGroup)[]): number {
  let count = 0
  for (const item of items) {
    if (isActivityGroup(item)) {
      count += 1 + item.children.length // 父项 + 子项
    } else {
      count += 1
    }
  }
  return count
}
