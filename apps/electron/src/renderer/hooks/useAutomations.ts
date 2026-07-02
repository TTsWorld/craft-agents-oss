/**
 * useAutomations
 *
 * 封装自动化（automation）的状态管理：
 * - 从 automations.json 加载自动化规则
 * - 订阅实时更新
 * - 测试、启用/禁用、复制、删除等处理函数
 * - 删除确认状态
 * - 把自动化同步到 Jotai atom，供跨组件访问
 */

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { automationsAtom } from '@/atoms/automations'
import { parseAutomationsConfig, type AutomationListItem, type TestResult, type ExecutionEntry } from '@/components/automations/types'

async function loadAutomationsFromServer(workspaceId: string): Promise<AutomationListItem[]> {
  const json = await window.electronAPI.getAutomations(workspaceId)
  if (!json) return [] // 尚未配置自动化规则
  return parseAutomationsConfig(json)
}

export interface UseAutomationsResult {
  automations: AutomationListItem[]
  automationTestResults: Record<string, TestResult>
  automationPendingDelete: string | null
  pendingDeleteAutomation: AutomationListItem | undefined
  setAutomationPendingDelete: (id: string | null) => void
  handleTestAutomation: (automationId: string) => void
  handleToggleAutomation: (automationId: string) => void
  handleDuplicateAutomation: (automationId: string) => void
  handleDeleteAutomation: (automationId: string) => void
  confirmDeleteAutomation: () => void
  getAutomationHistory: (automationId: string) => Promise<ExecutionEntry[]>
  handleReplayAutomation: (automationId: string, event: string) => void
}

export function useAutomations(
  activeWorkspaceId: string | null | undefined,
): UseAutomationsResult {
  const { t } = useTranslation()
  const [automations, setAutomations] = useState<AutomationListItem[]>([])
  const [automationTestResults, setAutomationTestResults] = useState<Record<string, TestResult>>({})
  const [automationPendingDelete, setAutomationPendingDelete] = useState<string | null>(null)

  // 把自动化同步到 Jotai atom，供跨组件访问（如 MainContentPanel）
  const setAutomationsAtom = useSetAtom(automationsAtom)
  useEffect(() => {
    setAutomationsAtom(automations)
  }, [automations, setAutomationsAtom])

  // 从服务端加载自动化，并一步把 lastExecutedAt 从历史记录中回填。
  // 这样避免了配置重载后时间戳被清空、而历史记录 effect 还没来得及合并的竞态。
  const loadAndHydrate = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const items = await loadAutomationsFromServer(activeWorkspaceId)
      try {
        const map = await window.electronAPI.getAutomationLastExecuted(activeWorkspaceId)
        for (const item of items) {
          item.lastExecutedAt = map[item.id] ?? item.lastExecutedAt
        }
      } catch { /* 历史记录不可用 —— 时间戳保持 undefined */ }
      setAutomations(items)
    } catch {
      setAutomations([])
    }
  }, [activeWorkspaceId])

  // 初始加载
  useEffect(() => {
    loadAndHydrate()
  }, [loadAndHydrate])

  // 订阅自动化实时更新（磁盘上 automations.json 变化时）
  useEffect(() => {
    if (!activeWorkspaceId) return
    const cleanup = window.electronAPI.onAutomationsChanged(() => { loadAndHydrate() })
    return () => { cleanup() }
  }, [activeWorkspaceId, loadAndHydrate])

  // 共享查找函数 —— 避免每个回调都写 automations.find()
  const findAutomation = useCallback((id: string) => automations.find(h => h.id === id), [automations])

  // 测试自动化 —— 汇总所有 action 的结果
  const handleTestAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return

    setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'running' } }))

    window.electronAPI.testAutomation({
      workspaceId: activeWorkspaceId,
      automationId: automation.id,
      automationName: automation.name,
      actions: automation.actions,
      permissionMode: automation.permissionMode,
      labels: automation.labels,
      telegramTopic: automation.telegramTopic,
    }).then((result) => {
      const actions = result.actions
      if (!actions || actions.length === 0) {
        setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'error', stderr: 'No actions to execute' } }))
        return
      }
      const hasError = actions.some(a => !a.success)
      const state = hasError ? 'error' : 'success'
      const stderr = actions.map(a => ('stderr' in a ? a.stderr : 'error' in a ? a.error : undefined)).filter(Boolean).join('\n')
      const duration = actions.reduce((sum, a) => sum + (a.duration ?? 0), 0)
      setAutomationTestResults(prev => ({
        ...prev,
        [automationId]: {
          state,
          stderr: stderr || undefined,
          duration: duration || undefined,
        },
      }))
    }).catch((err: Error) => {
      setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'error', stderr: err.message } }))
    })
  }, [findAutomation, activeWorkspaceId])

  const handleToggleAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return
    window.electronAPI.setAutomationEnabled(
      activeWorkspaceId,
      automation.event,
      automation.matcherIndex,
      !automation.enabled,
    ).catch(() => {
      toast.error(t('toast.failedToToggleAutomation'))
    })
  }, [findAutomation, activeWorkspaceId])

  const handleDuplicateAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return
    window.electronAPI.duplicateAutomation(activeWorkspaceId, automation.event, automation.matcherIndex)
      .catch(() => toast.error(t('toast.failedToDuplicateAutomation')))
  }, [findAutomation, activeWorkspaceId])

  // 删除：先显示确认弹窗
  const handleDeleteAutomation = useCallback((automationId: string) => {
    setAutomationPendingDelete(automationId)
  }, [])

  const pendingDeleteAutomation = automationPendingDelete ? findAutomation(automationPendingDelete) : undefined

  const confirmDeleteAutomation = useCallback(() => {
    if (!pendingDeleteAutomation || !activeWorkspaceId) return
    window.electronAPI.deleteAutomation(activeWorkspaceId, pendingDeleteAutomation.event, pendingDeleteAutomation.matcherIndex)
      .catch(() => toast.error(t('toast.failedToDeleteAutomation')))
    setAutomationPendingDelete(null)
  }, [pendingDeleteAutomation, activeWorkspaceId])

  // 获取某个自动化的执行历史
  const getAutomationHistory = useCallback(async (automationId: string): Promise<ExecutionEntry[]> => {
    if (!activeWorkspaceId) return []
    try {
      const entries = await window.electronAPI.getAutomationHistory(activeWorkspaceId, automationId, 20)
      const automation = findAutomation(automationId)
      return entries.map(e => ({
        id: `${e.id}-${e.ts}`,
        automationId: e.id,
        event: automation?.event ?? 'LabelAdd',
        status: e.ok ? 'success' as const : 'error' as const,
        duration: e.webhook?.durationMs ?? 0,
        timestamp: e.ts,
        sessionId: e.sessionId,
        actionSummary: e.webhook
          ? `Webhook ${e.webhook.method} ${e.webhook.url}${e.webhook.attempts && e.webhook.attempts > 1 ? ` (${e.webhook.attempts} attempts)` : ''}`
          : e.prompt,
        error: e.webhook?.error ?? e.error,
        webhookDetails: e.webhook ? {
          method: e.webhook.method,
          url: e.webhook.url,
          statusCode: e.webhook.statusCode,
          durationMs: e.webhook.durationMs,
          attempts: e.webhook.attempts,
          error: e.webhook.error,
          responseBody: e.webhook.responseBody,
        } : undefined,
      }))
    } catch {
      return []
    }
  }, [activeWorkspaceId, findAutomation])

  // 重放某个自动化的失败 webhook action
  const handleReplayAutomation = useCallback((automationId: string, event: string) => {
    if (!activeWorkspaceId) return
    window.electronAPI.replayAutomation(activeWorkspaceId, automationId, event)
      .then(() => {
        toast.success(t('toast.webhookReplayCompleted'))
      })
      .catch((err: Error) => {
        toast.error(t("toast.replayFailed", { error: err.message }))
      })
  }, [activeWorkspaceId])

  return {
    automations,
    automationTestResults,
    automationPendingDelete,
    pendingDeleteAutomation,
    setAutomationPendingDelete,
    handleTestAutomation,
    handleToggleAutomation,
    handleDuplicateAutomation,
    handleDeleteAutomation,
    confirmDeleteAutomation,
    getAutomationHistory,
    handleReplayAutomation,
  }
}
