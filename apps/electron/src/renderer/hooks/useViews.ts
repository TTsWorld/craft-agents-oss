/**
 * useViews Hook
 *
 * 加载视图配置（view config），编译 Filtrex 表达式，
 * 并返回一个评估函数用于判断会话是否匹配某个视图。
 *
 * 编译在配置加载时只执行一次（useMemo）。编译后的函数以原生 JS 速度运行，
 * 每次评估不再有解析开销。
 *
 * LABELS_CHANGED 事件触发时也会重新编译（视图变更复用同一广播）。
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { ViewConfig, CompiledView, ViewEvaluationContext } from '@craft-agent/shared/views'
import { compileAllViews, evaluateViews, buildViewContext } from '@craft-agent/shared/views'
import type { SessionMeta } from '../atoms/sessions'

export interface UseViewsResult {
  /** 原始视图配置（用于侧边栏、设置等展示） */
  viewConfigs: ViewConfig[]
  /** 加载状态 */
  isLoading: boolean
  /**
   * 评估会话匹配哪些已编译视图。
   * 返回匹配视图的配置数组。
   * 快速：运行编译后的原生 JS 函数，无需解析。
   */
  evaluateSession: (meta: SessionMeta) => ViewConfig[]
  /** 强制从 IPC 重新获取 */
  refresh: () => Promise<void>
}

/**
 * 加载并编译某个工作区的视图。
 * 表达式在加载时一次性编译，之后每次渲染按会话评估。
 * 通过 LABELS_CHANGED 事件订阅实时变更（视图变更复用同一广播）。
 */
export function useViews(workspaceId: string | null): UseViewsResult {
  const [configs, setConfigs] = useState<ViewConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setConfigs([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const views = await window.electronAPI.listViews(workspaceId)
      setConfigs(views)
    } catch (err) {
      console.error('[useViews] Failed to load views:', err)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // workspace 变化时加载
  useEffect(() => {
    refresh()
  }, [refresh])

  // 监听实时变化（视图变更触发 LABELS_CHANGED 广播）
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onLabelsChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  // 配置变化时一次性编译所有表达式。
  // 这是一次性解析开销，之后评估都是原生速度。
  const compiled: CompiledView[] = useMemo(() => {
    if (configs.length === 0) return []
    return compileAllViews(configs)
  }, [configs])

  // 缓存评估函数引用，避免每次渲染都生成新函数。
  // 先根据 SessionMeta 构建评估上下文，再运行所有编译后的函数。
  const evaluateSession = useCallback((meta: SessionMeta): ViewConfig[] => {
    if (compiled.length === 0) return []

    // 把 SessionMeta 字段映射为表达式期望的扁平上下文对象
    const context: ViewEvaluationContext = buildViewContext({
      name: meta.name,
      preview: meta.preview,
      sessionStatus: meta.sessionStatus,
      permissionMode: meta.permissionMode,
      model: meta.model,
      lastMessageRole: meta.lastMessageRole,
      lastMessageAt: meta.lastMessageAt,
      createdAt: meta.createdAt,
      messageCount: meta.messageCount,
      isFlagged: meta.isFlagged,
      hasUnread: meta.hasUnread,
      isProcessing: meta.isProcessing,
      labels: meta.labels,
      tokenUsage: meta.tokenUsage,
    })

    return evaluateViews(context, compiled)
  }, [compiled])

  return {
    viewConfigs: configs,
    isLoading,
    evaluateSession,
    refresh,
  }
}
