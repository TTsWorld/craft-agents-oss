import type { Session, TransportConnectionState } from '../../shared/types'

interface MessageLoadMeta {
  messageCount?: number
  lastFinalMessageId?: string
}

export interface SessionMessagesLoadStateInput {
  session: Pick<Session, 'messages' | 'messageCount' | 'lastFinalMessageId'> | null | undefined
  sessionMeta: MessageLoadMeta | null | undefined
  messagesLoaded: boolean
  loadError?: string | null
}

export interface SessionMessagesLoadState {
  hasLoadedFlag: boolean
  hasInMemoryMessages: boolean
  isKnownEmptySession: boolean
  hasExpectedPersistedMessages: boolean
  hasStaleLoadedFlag: boolean
  messagesReady: boolean
  messagesLoading: boolean
  error: string | null
}

/**
 * 根据显式的 loaded 标记与会话 atom 中的实际数据，推导渲染进程的消息加载 UI 状态。
 *
 * loaded 标记与会话数据被故意分开，以支持懒加载；
 * 但恢复/重连路径可能短暂地让两者不同步。
 * 如果会话 atom 里已经有消息，就应该渲染聊天记录，而不是被陈旧的 loading 状态遮住。
 */
export function deriveSessionMessagesLoadState({
  session,
  sessionMeta,
  messagesLoaded,
  loadError,
}: SessionMessagesLoadStateInput): SessionMessagesLoadState {
  const hasLoadedFlag = messagesLoaded
  const messageCount = session?.messageCount ?? sessionMeta?.messageCount
  const hasInMemoryMessages = (session?.messages?.length ?? 0) > 0
  const hasExpectedPersistedMessages = (messageCount ?? 0) > 0
    || !!session?.lastFinalMessageId
    || !!sessionMeta?.lastFinalMessageId
  const isKnownEmptySession = !!session
    && messageCount === 0
    && !session?.lastFinalMessageId
    && !sessionMeta?.lastFinalMessageId
  const hasStaleLoadedFlag = hasLoadedFlag && hasExpectedPersistedMessages && !hasInMemoryMessages
  const messagesReady = (hasLoadedFlag && !hasStaleLoadedFlag) || hasInMemoryMessages || isKnownEmptySession
  const error = messagesReady ? null : (loadError ?? null)

  return {
    hasLoadedFlag,
    hasInMemoryMessages,
    isKnownEmptySession,
    hasExpectedPersistedMessages,
    hasStaleLoadedFlag,
    messagesReady,
    messagesLoading: !messagesReady && !error,
    error,
  }
}

/**
 * 判断会话加载失败是否应按 transport 回退处理。
 * 仅当 transport 处于远程模式且错误/状态属于连接层问题（auth、network、timeout、连接中、重连中、失败、断开）时返回 true。
 */
export function shouldTreatSessionLoadFailureAsTransportFallback(
  state: TransportConnectionState | null | undefined,
): boolean {
  if (!state || state.mode !== 'remote') return false

  if (state.lastError && ['auth', 'network', 'timeout'].includes(state.lastError.kind)) {
    return true
  }

  return state.status === 'connecting'
    || state.status === 'reconnecting'
    || state.status === 'failed'
    || state.status === 'disconnected'
}

/**
 * 把会话加载错误格式化为可展示的字符串。
 */
export function formatSessionLoadFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown error'
}
