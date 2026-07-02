/**
 * 消息操作辅助函数
 *
 * 纯工具函数：用于查找和更新消息。
 * 所有查找都按 ID（turnId、toolUseId）进行，绝不按数组下标。
 */

import type { Message, Session } from '../../shared/types'

let messageIdCounter = 0

/**
 * 生成唯一消息 ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`
}

/**
 * 按 turnId 查找消息下标
 * 找不到时返回 -1
 */
export function findMessageByTurnId(
  messages: Message[],
  turnId: string | undefined,
  role?: 'assistant' | 'tool'
): number {
  if (!turnId) return -1
  return messages.findIndex(m =>
    m.turnId === turnId && (!role || m.role === role)
  )
}

/**
 * 按 turnId 查找正在流式输出的 assistant 消息
 * 如果未提供 turnId，则回退到最近一条流式 assistant 消息
 */
export function findStreamingMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    const index = messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId && m.isStreaming
    )
    if (index !== -1) return index
  }
  // 回退：从后往前找最近一条处于流式状态的 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].isStreaming) {
      return i
    }
  }
  return -1
}

/**
 * 按 turnId 查找 assistant 消息（无论是否流式）
 */
export function findAssistantMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    const index = messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId
    )
    if (index !== -1) return index
  }
  // 回退：从后往前找最近一条流式 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].isStreaming) {
      return i
    }
  }
  return -1
}

/**
 * 按 toolUseId 查找工具消息
 */
export function findToolMessage(
  messages: Message[],
  toolUseId: string
): number {
  return messages.findIndex(m => m.toolUseId === toolUseId)
}

/**
 * 更新指定下标的消息，返回新的 Session
 * 总是创建新引用（不可变更新），不修改原对象
 * @param updateTimestamp - 为 true 时同时更新 lastMessageAt
 */
export function updateMessageAt(
  session: Session,
  index: number,
  updates: Partial<Message>,
  updateTimestamp = false
): Session {
  if (index < 0 || index >= session.messages.length) {
    return session
  }
  // 展开运算符 ... 创建数组和对象的浅拷贝，避免修改原 Session
  const messages = [...session.messages]
  messages[index] = { ...messages[index], ...updates }
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * 在会话末尾追加一条消息，返回新的 Session
 * @param updateTimestamp - 为 false 时不更新 lastMessageAt（用于中间态/工具消息）
 */
export function appendMessage(
  session: Session,
  message: Message,
  updateTimestamp = false
): Session {
  // 防护：如果已存在相同 ID 的消息则跳过（避免 Windows 上重复事件导致消息重复）
  if (message.id && session.messages.some(m => m.id === message.id)) {
    return session
  }

  // 判断该角色是否应更新 lastMessageRole（用于侧边栏角标显示）
  const badgeRoles = ['user', 'assistant', 'plan', 'tool', 'error'] as const
  // typeof badgeRoles[number] 表示联合类型 'user' | 'assistant' | ...
  const roleForBadge = badgeRoles.includes(message.role as typeof badgeRoles[number])
    ? message.role as Session['lastMessageRole']
    : undefined

  return {
    ...session,
    messages: [...session.messages, message],
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
    ...(roleForBadge ? { lastMessageRole: roleForBadge } : {}),
  }
}

/**
 * 在指定下标插入一条消息，返回新的 Session
 * @param updateTimestamp - 为 false 时不更新 lastMessageAt（用于中间态/工具消息）
 */
export function insertMessageAt(
  session: Session,
  index: number,
  message: Message,
  updateTimestamp = false
): Session {
  const messages = [...session.messages]
  messages.splice(index, 0, message)
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * 为指定 ID 创建一个空的 Session 对象
 */
export function createEmptySession(sessionId: string, workspaceId: string, workspaceName: string = ''): Session {
  return {
    id: sessionId,
    workspaceId,
    workspaceName,
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: true,
  }
}
