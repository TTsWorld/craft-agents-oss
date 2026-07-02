import type { SessionMeta } from '@/atoms/sessions'

/**
 * 断线重连后决定需要刷新哪些会话。
 *
 * 当 Electron 与后端 transport 从断开恢复到连接时：
 * - 当前正在看的会话（activeSessionId）需要刷新，确保 UI 与后端一致；
 * - 所有仍在处理中（isProcessing）的会话也需要刷新，因为断线期间可能产生了新消息或状态变更。
 */
export function getSessionsToRefreshAfterStaleReconnect(
  metaMap: Map<string, SessionMeta>,
  activeSessionId: string | null
): string[] {
  const refreshIds = new Set<string>()

  if (activeSessionId) {
    refreshIds.add(activeSessionId)
  }

  for (const [sessionId, meta] of metaMap) {
    if (meta.isProcessing) {
      refreshIds.add(sessionId)
    }
  }

  return [...refreshIds]
}
