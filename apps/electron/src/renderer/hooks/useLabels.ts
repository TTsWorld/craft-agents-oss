/**
 * useLabels Hook
 *
 * 加载并管理工作区的标签（label）。
 * 返回标签树（带 children 的嵌套结构）以及供扁平查找用的 flatLabels。
 * 当 workspace 变化或标签配置变化时自动刷新。
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { flattenLabels } from '@craft-agent/shared/labels'

export interface UseLabelsResult {
  /** 标签树（根节点及其嵌套子节点） */
  labels: LabelConfig[]
  /** 拍平后的标签列表，用于查找和非层级展示 */
  flatLabels: LabelConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * 通过 IPC 加载某个工作区的标签。
 * 返回树形结构（带嵌套 children 的标签）。
 * workspaceId 变化时自动刷新。
 * 通过 LABELS_CHANGED 事件订阅磁盘上标签配置的实时变更。
 */
export function useLabels(workspaceId: string | null): UseLabelsResult {
  const [labels, setLabels] = useState<LabelConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 用 useMemo 缓存拍平后的标签，避免每次渲染重新计算
  const flatLabels = useMemo(() => flattenLabels(labels), [labels])

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setLabels([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const configs = await window.electronAPI.listLabels(workspaceId)
      setLabels(configs)
      setError(null)
    } catch (err) {
      console.error('[useLabels] Failed to load labels:', err)
      setError(err instanceof Error ? err.message : 'Failed to load labels')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // workspace 变化时加载
  useEffect(() => {
    refresh()
  }, [refresh])

  // 订阅实时标签变化（配置文件变化）
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onLabelsChanged((changedWorkspaceId) => {
      // 只处理当前 workspace 的变化
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  return {
    labels,
    flatLabels,
    isLoading,
    error,
    refresh,
  }
}
