/**
 * 文本事件处理器
 *
 * 处理 text_delta（流式文本片段）和 text_complete（文本完成）事件。
 * 都是纯函数，只返回新状态，不产生副作用。
 */

import type { SessionState, StreamingState, TextDeltaEvent, TextCompleteEvent } from '../types'
import type { Message } from '../../../shared/types'
import {
  findStreamingMessage,
  findAssistantMessage,
  updateMessageAt,
  appendMessage,
  generateMessageId
} from '../helpers'

/**
 * 处理 text_delta：累积流式文本内容
 *
 * 如果没有正在流式的消息就创建一条，否则更新已有消息。
 * 按 turnId 查找，绝不按数组下标。
 */
export function handleTextDelta(
  state: SessionState,
  event: TextDeltaEvent
): SessionState {
  const { session, streaming } = state

  // 在 streaming state 中累积文本片段
  const newStreaming: StreamingState = streaming
    ? {
        ...streaming,
        content: streaming.content + event.delta,
        turnId: event.turnId ?? streaming.turnId
      }
    : {
        content: event.delta,
        turnId: event.turnId
      }

  // 按 turnId 查找已有的流式消息
  const streamingIndex = findStreamingMessage(session.messages, event.turnId)

  if (streamingIndex !== -1) {
    // 消息已存在：追加内容
    const currentMsg = session.messages[streamingIndex]
    const updatedSession = updateMessageAt(session, streamingIndex, {
      content: currentMsg.content + event.delta,
    })
    return { session: updatedSession, streaming: newStreaming }
  }

  // 没有找到流式消息：新建一条
  // 流式消息不更新 lastMessageAt，因为它还是中间态
  const newMessage: Message = {
    id: generateMessageId(),
    role: 'assistant',
    content: event.delta,
    timestamp: Date.now(),
    isStreaming: true,
    isPending: true,
    turnId: event.turnId,
  }

  return {
    session: appendMessage(session, newMessage, false),
    streaming: newStreaming,
  }
}

/**
 * 处理 text_complete：把流式消息定格为正式消息
 *
 * 设置 isStreaming: false、isPending: false。
 * 如果找不到消息，会主动创建一条（修复竞态 bug）。
 * 优先使用 SDK 给的完整文本 event.text，而不是本地累积的内容。
 */
export function handleTextComplete(
  state: SessionState,
  event: TextCompleteEvent
): SessionState {
  const { session, streaming } = state

  // 先按 turnId 找流式消息，找不到再匹配任意 assistant 消息
  let msgIndex = findStreamingMessage(session.messages, event.turnId)
  if (msgIndex === -1) {
    msgIndex = findAssistantMessage(session.messages, event.turnId)
  }

  if (msgIndex !== -1) {
    const existingMsg = session.messages[msgIndex]

    // 不要把一条已完成的中间消息再覆盖成另一条中间消息——
    // 每个 thinking 块（例如工具调用之间的 Codex 推理）应当是独立消息
    if (!existingMsg.isStreaming && existingMsg.isIntermediate && event.isIntermediate) {
      msgIndex = -1
    }
  }

  if (msgIndex !== -1) {
    // 更新已有消息为最终内容
    // 只有非中间态消息才更新 lastMessageAt
    const shouldUpdateTimestamp = !event.isIntermediate
    const existingMsg = session.messages[msgIndex]
    // 回退链：SDK 文本 → 本地累积的流式内容 → 已有消息内容
    // 防止 SDK 为空或竞态导致 event.text 缺失
    const resolvedContent = event.text || streaming?.content || existingMsg?.content || ''
    const updatedSession = updateMessageAt(session, msgIndex, {
      // 把 renderer 临时生成的 ID 替换为主进程给出的权威 ID，
      // 这样 branchFromMessageId 才能对齐持久化后的 session.jsonl。
      ...(event.messageId ? { id: event.messageId } : {}),
      content: resolvedContent,
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
      // 用主进程的单调时间戳覆盖 text_delta 里的 Date.now()，保证重载后顺序一致
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    }, shouldUpdateTimestamp)
    return { session: updatedSession, streaming: null }
  }

  // 消息没找到：主动创建一条
  // 这处理了 text_complete 比 text_delta 的 setSessions 更早到达的竞态情况
  const newMessage: Message = {
    id: event.messageId ?? generateMessageId(),
    role: 'assistant',
    content: event.text || streaming?.content || '',
    timestamp: event.timestamp ?? Date.now(),
    isStreaming: false,
    isPending: false,
    isIntermediate: event.isIntermediate,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
  }

  // 只有非中间态消息才更新 lastMessageAt
  const shouldUpdateTimestamp = !event.isIntermediate

  return {
    session: appendMessage(session, newMessage, shouldUpdateTimestamp),
    streaming: null,
  }
}
