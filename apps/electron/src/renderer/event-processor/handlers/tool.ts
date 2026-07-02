/**
 * 工具事件处理器
 *
 * 处理 tool_start、tool_result 以及后台任务相关事件。
 * 都是纯函数，只返回新状态，不产生副作用。
 */

import type { SessionState, ToolStartEvent, ToolResultEvent, TaskBackgroundedEvent, ShellBackgroundedEvent, TaskProgressEvent, TaskCompletedEvent } from '../types'
import type { Message } from '../../../shared/types'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import {
  findToolMessage,
  updateMessageAt,
  appendMessage,
  generateMessageId
} from '../helpers'

/**
 * 处理 tool_start：创建或更新一条工具消息
 *
 * SDK 对每个工具会发两次事件：
 * 第一次来自 stream_event（input 为空），第二次来自 assistant message（input 完整）。
 * 这里两种情况都处理。
 */
export function handleToolStart(
  state: SessionState,
  event: ToolStartEvent
): SessionState {
  const { session, streaming } = state

  // 检查工具消息是否已存在（SDK 会发送两次）
  const existingIndex = findToolMessage(session.messages, event.toolUseId)

  if (existingIndex !== -1) {
    // 用完整输入更新（第二次事件才带完整 input）
    const updatedSession = updateMessageAt(session, existingIndex, {
      toolInput: event.toolInput,
      toolIntent: event.toolIntent,
      toolDisplayName: event.toolDisplayName,
      toolDisplayMeta: event.toolDisplayMeta,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    })
    return { session: updatedSession, streaming }
  }

  // 新建工具消息
  const toolMessage: Message = {
    id: generateMessageId(),
    role: 'tool',
    content: '',
    timestamp: event.timestamp ?? Date.now(),
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    toolInput: event.toolInput,
    toolStatus: 'executing',
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
    toolIntent: event.toolIntent,
    toolDisplayName: event.toolDisplayName,
    toolDisplayMeta: event.toolDisplayMeta,
  }

  return {
    session: appendMessage(session, toolMessage),
    streaming,
  }
}

/**
 * 处理 tool_result：工具执行完成
 *
 * 更新对应工具消息的结果。如果找不到工具消息（乱序到达），
 * 就新建一条带结果的工具消息。
 */
export function handleToolResult(
  state: SessionState,
  event: ToolResultEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  // 通过 isError 标志或结果文本前缀推断是否出错
  const inferredError = event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(event.result || '')

  if (toolIndex !== -1) {
    // 检测“输出已持久化”：SDK 标记为错误，但数据其实已成功保存
    const isPersistedOutput = inferredError && (
      event.result?.includes('Output has been saved to') ||
      event.result?.includes('Full output saved to')
    )

    const effectiveIsError = isPersistedOutput ? false : inferredError

    // 如果工具已经后台化，则保留该状态——最终状态由 task_completed 设置。
    // tool_result 到达时可能只带了 agentId，但任务实际还在后台运行。
    const existingMessage = session.messages[toolIndex]
    const isBackgrounded = existingMessage?.toolStatus === 'backgrounded' || existingMessage?.isBackground
    const newToolStatus = isBackgrounded ? 'backgrounded' : (effectiveIsError ? 'error' : 'completed')

    // 更新已有工具消息
    let updatedSession = updateMessageAt(session, toolIndex, {
      toolResult: event.result,
      toolStatus: newToolStatus,
      isError: effectiveIsError,
      errorCode: isPersistedOutput ? 'response_too_large' : undefined,
    })

    // 安全网：当父任务完成时，自动把尚未结束的子工具标记为完成。
    // 用于处理子工具结果事件丢失的情况。
    const completedTool = updatedSession.messages[toolIndex]
    if (completedTool && (isParentTaskTool(completedTool.toolName || '') || completedTool.toolName === 'TaskOutput')) {
      const hasOrphanedChildren = updatedSession.messages.some(
        m => m.parentToolUseId === event.toolUseId
          && m.toolStatus !== 'completed'
          && m.toolStatus !== 'error'
      )
      if (hasOrphanedChildren) {
        const updatedMessages = updatedSession.messages.map(m => {
          if (
            m.parentToolUseId === event.toolUseId
            && m.toolStatus !== 'completed'
            && m.toolStatus !== 'error'
          ) {
            return { ...m, toolStatus: 'completed' as const, toolResult: m.toolResult || '' }
          }
          return m
        })
        updatedSession = { ...updatedSession, messages: updatedMessages }
      }
    }

    return { session: updatedSession, streaming }
  }

  // 没有匹配的 tool_start：根据结果创建消息。
  // 这在后台子 Agent 工具里很常见：tool_result 先于 tool_start 到达。
  // 如果后续 tool_start 到达，findToolMessage 会按 toolUseId 找到这条消息并补充 input/intent/displayMeta。

  // 检测“输出已持久化”
  const isPersistedOutput = inferredError && (
    event.result?.includes('Output has been saved to') ||
    event.result?.includes('Full output saved to')
  )

  const effectiveIsError = isPersistedOutput ? false : inferredError

  const toolMessage: Message = {
    id: generateMessageId(),
    role: 'tool',
    content: '',
    timestamp: event.timestamp ?? Date.now(),
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    toolResult: event.result,
    toolStatus: effectiveIsError ? 'error' : 'completed',
    isError: effectiveIsError,
    errorCode: isPersistedOutput ? 'response_too_large' : undefined,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
  }

  return {
    session: appendMessage(session, toolMessage),
    streaming,
  }
}

/**
 * 处理 task_backgrounded：把工具标记为后台运行，并记录任务 ID
 *
 * 当 Task 以 run_in_background: true 执行时，SDK 会立即返回 agentId。
 * 这个事件把工具消息状态更新为 'backgrounded' 并保存 taskId，供后续 TaskOutput 轮询。
 */
export function handleTaskBackgrounded(
  state: SessionState,
  event: TaskBackgroundedEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  if (toolIndex !== -1) {
    // 更新工具状态为后台化，并记录任务 ID
    const updatedSession = updateMessageAt(session, toolIndex, {
      toolStatus: 'backgrounded',
      taskId: event.taskId,
      isBackground: true,
    })
    return { session: updatedSession, streaming }
  }

  // 工具未找到：理论上不应发生，直接原样返回
  return state
}

/**
 * 处理 shell_backgrounded：把 shell 工具标记为后台运行，并记录 shell ID
 *
 * 当 Bash 命令以 run_in_background: true 执行时，SDK 会立即返回 shell_id。
 * 这个事件把工具消息状态更新为 'backgrounded' 并保存 shellId。
 */
export function handleShellBackgrounded(
  state: SessionState,
  event: ShellBackgroundedEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  if (toolIndex !== -1) {
    // 更新工具状态为后台化，并记录 shell ID
    const updatedSession = updateMessageAt(session, toolIndex, {
      toolStatus: 'backgrounded',
      shellId: event.shellId,
      isBackground: true,
    })
    return { session: updatedSession, streaming }
  }

  // 工具未找到：理论上不应发生，直接原样返回
  return state
}

/**
 * 处理 task_progress：更新后台任务已运行秒数
 *
 * SDK 会为后台任务发送 tool_progress 事件，携带 elapsed_time_seconds。
 * 这里把 elapsedSeconds 更新到工具消息上，供 UI 展示实时进度。
 */
export function handleTaskProgress(
  state: SessionState,
  event: TaskProgressEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  if (toolIndex !== -1) {
    // 更新已运行时间，用于实时进度展示
    const updatedSession = updateMessageAt(session, toolIndex, {
      elapsedSeconds: event.elapsedSeconds,
    })
    return { session: updatedSession, streaming }
  }

  // 工具未找到：理论上不应发生，直接原样返回
  return state
}

/**
 * 处理 task_completed：后台任务完成时更新工具消息
 *
 * 当后台任务完成，SDK 会发送 task_notification。
 * 本处理器按 taskId 找到对应的工具消息并更新状态和结果摘要。
 */
export function handleTaskCompleted(
  state: SessionState,
  event: TaskCompletedEvent
): SessionState {
  const { session, streaming } = state

  // 按 taskId 查找工具消息（taskId 在处理 task_backgrounded 时已写入）
  const toolIndex = session.messages.findIndex(m => m.taskId === event.taskId)

  if (toolIndex !== -1) {
    const updatedSession = updateMessageAt(session, toolIndex, {
      toolStatus: event.status === 'failed' ? 'error' : 'completed',
      toolResult: event.summary || `Background task ${event.status}`,
    })
    return { session: updatedSession, streaming }
  }

  // 按 taskId 找不到工具：直接原样返回
  return state
}
