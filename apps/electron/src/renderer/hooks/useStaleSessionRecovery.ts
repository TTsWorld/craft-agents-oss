/**
 * 僵死会话恢复看门狗
 *
 * 用于重连重放协议覆盖不到的边界情况：
 * - React useEffect 重新注册期间丢失的事件
 * - 未触发完整 WS 断连的单个丢事件
 * - 服务器中途崩溃但断连信号未干净发送
 *
 * 定期检查 isProcessing=true 但长时间没有新事件的会话，
 * 从服务器持久化状态刷新它们。
 *
 * 使用宽松的 120 秒阈值，避免把长时间合法工具执行误判为僵死
 * （有些工具确实会运行 60 秒以上）。
 */

import { useCallback, useEffect, useRef } from 'react'
import { getDefaultStore } from 'jotai'
import { sessionMetaMapAtom } from '@/atoms/sessions'

type JotaiStore = ReturnType<typeof getDefaultStore>

const STALE_THRESHOLD_MS = 120_000 // 2 分钟，避免误判
const CHECK_INTERVAL_MS = 30_000   // 每 30 秒检查一次

interface UseStaleSessionRecoveryOptions {
  store: JotaiStore
  refreshSessionFromServer: (sessionId: string) => Promise<'refreshed' | 'preserved_stale_messages' | 'failed'>
}

/**
 * 跟踪每个会话最近一次收到事件的时间。
 * 若某会话 isProcessing=true 但超过 STALE_THRESHOLD_MS 没有事件，
 * 则视为卡住，从服务器刷新。
 */
export function useStaleSessionRecovery({
  store,
  refreshSessionFromServer,
}: UseStaleSessionRecoveryOptions): {
  /** 每次收到会话事件时调用，重置看门狗计时器 */
  trackSessionActivity: (sessionId: string) => void
} {
  const lastEventTimestamps = useRef<Map<string, number>>(new Map())
  const refreshingSessionIds = useRef<Set<string>>(new Set())

  const trackSessionActivity = useCallback((sessionId: string) => {
    lastEventTimestamps.current.set(sessionId, Date.now())
  }, [])

  useEffect(() => {
    const timer = setInterval(async () => {
      const now = Date.now()
      const allMeta = store.get(sessionMetaMapAtom)

      for (const [sessionId, meta] of allMeta) {
        if (!meta.isProcessing) {
          // 不在处理中，清理跟踪
          lastEventTimestamps.current.delete(sessionId)
          continue
        }

        const lastEvent = lastEventTimestamps.current.get(sessionId)
        if (!lastEvent) {
          // 正在处理但还没有跟踪到事件，开始跟踪
          lastEventTimestamps.current.set(sessionId, now)
          continue
        }

        if (now - lastEvent < STALE_THRESHOLD_MS) {
          continue // 仍在阈值内
        }

        if (refreshingSessionIds.current.has(sessionId)) {
          continue
        }

        // 判定为僵死，从服务器刷新
        console.warn(`[StaleRecovery] Session ${sessionId} stuck in processing for ${Math.round((now - lastEvent) / 1000)}s — refreshing`)

        refreshingSessionIds.current.add(sessionId)
        try {
          const refreshed = await refreshSessionFromServer(sessionId)
          if (refreshed === 'refreshed') {
            // 真正刷新成功后移除跟踪
            lastEventTimestamps.current.delete(sessionId)
          }
        } catch (err) {
          console.error(`[StaleRecovery] Failed to refresh session ${sessionId}:`, err)
        } finally {
          refreshingSessionIds.current.delete(sessionId)
        }
      }
    }, CHECK_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [store, refreshSessionFromServer])

  return { trackSessionActivity }
}
