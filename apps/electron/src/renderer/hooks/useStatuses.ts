/**
 * useStatuses Hook
 *
 * 加载并管理工作区的状态配置（status config）。
 * 当 workspace 变化时自动刷新。
 */

import { useState, useEffect, useCallback } from 'react'
import type { StatusConfig } from '@craft-agent/shared/statuses'
import { clearIconCache } from '@/config/session-status-config'

export interface UseStatusesResult {
  statuses: StatusConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * 通过 IPC 加载某个工作区的状态配置。
 * workspaceId 变化时自动刷新。
 *
 * 若要感知 Agent 对状态配置文件的修改，可以：
 * - 简单方案：定时轮询
 * - 实时方案：在主进程监听文件变化并推送事件
 */
export function useStatuses(workspaceId: string | null): UseStatusesResult {
  const [statuses, setStatuses] = useState<StatusConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setStatuses([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const configs = await window.electronAPI.listStatuses(workspaceId)
      setStatuses(configs)
      setError(null)
    } catch (err) {
      console.error('[useStatuses] Failed to load statuses:', err)
      setError(err instanceof Error ? err.message : 'Failed to load statuses')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // workspace 变化时加载
  useEffect(() => {
    refresh()
  }, [refresh])

  // 监听实时状态变化（配置文件或图标文件变化）
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onStatusesChanged((changedWorkspaceId) => {
      // 只刷新属于当前 workspace 的数据
      if (changedWorkspaceId === workspaceId) {
        clearIconCache()  // 刷新前先清掉缓存的图标文件
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  return {
    statuses,
    isLoading,
    error,
    refresh,
  }
}
