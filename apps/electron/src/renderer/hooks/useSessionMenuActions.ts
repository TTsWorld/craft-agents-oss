/**
 * useSessionMenuActions
 *
 * 会话菜单副作用（分享 / 刷新标题 / 复制路径 / 在 Finder 中显示 / 在新面板打开 /
 * 分享子菜单操作 / 标签切换）的单一事实来源。
 * 同时被 `SessionMenu`（桌面端下拉/上下文菜单）和 `CompactSessionMenu`
 *（紧凑模式抽屉）消费，因此新增会话操作只需在一个地方接线。
 *
 * 还拥有**乐观标签状态**：父组件的标签变化管道
 *（`onLabelsChange` → IPC → 服务端 → `labels_changed` 事件 → atom → re-render）
 * 是异步的，如果第二次快速点击基于 props 中仍然过期的 `item.labels` 计算，
 * 就会覆盖第一次点击的更新。本 hook 用 `useRef` 维护一份本地乐观副本，
 * 使切换操作能同步读取最新值（不经过 React 更新队列，避免 Strict Mode 下不纯地重复触发 onLabelsChange）。
 * 只有当服务端确认了我们的最近一次本地变更（通过 `lastSentKeyRef` 跟踪）时才从 prop 同步，
 * 避免勾选闪烁，且无需完整请求追踪层。会话 ID 变化时状态会硬重置，
 * 防止上一个会话的待定乐观状态泄漏到新会话。
 *
 * 纯标签变更逻辑位于 `@craft-agent/shared/labels`（`toggleLabelInList`）并在那里做单元测试。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { navigate, routes } from '@/lib/navigate'
import { extractLabelId, toggleLabelInList } from '@craft-agent/shared/labels'
import type { SessionMeta } from '@/atoms/sessions'

export interface UseSessionMenuActionsOptions {
  item: SessionMeta
  onLabelsChange?: (labels: string[]) => void
}

export interface SessionMenuActions {
  /** 当前已应用（乐观）的基础标签 ID 集合 */
  appliedLabelIds: Set<string>
  /** 切换标签：不存在则添加，存在则移除该基础 ID 的所有条目 */
  toggleLabel: (labelId: string) => void
  share: () => Promise<void>
  showInFinder: () => void
  copyPath: () => Promise<void>
  refreshTitle: () => Promise<void>
  openInNewPanel: () => void
  /** 在系统浏览器中打开会话的已发布分享链接（未分享则无操作） */
  openSharedInBrowser: () => void
  /** 复制会话的已发布分享链接到剪贴板（未分享则无操作） */
  copySharedLink: () => Promise<void>
  /** 重新发布分享以刷新快照 */
  updateShare: () => Promise<void>
  /** 撤销分享 */
  revokeShare: () => Promise<void>
}

// SOH (U+0001) —— 不可打印字符，不会与标签 ID（校验规则 [a-z0-9-]）
// 或值（本身可能含 '::'）冲突。
const LABEL_KEY_SEPARATOR = String.fromCharCode(1)

function joinLabelKey(labels: readonly string[] | undefined): string {
  return (labels ?? []).join(LABEL_KEY_SEPARATOR)
}

export function useSessionMenuActions({
  item,
  onLabelsChange,
}: UseSessionMenuActionsOptions): SessionMenuActions {
  const { t } = useTranslation()
  const sessionId = item.id
  const sharedUrl = item.sharedUrl
  const propLabels = item.labels

  const [optimisticLabels, setOptimisticLabels] = React.useState<string[]>(() => propLabels ?? [])
  // `optimisticLabels` 的镜像，让切换操作能同步读取最新值，
  // 不经过 React 更新队列。在 state updater 里读取会不纯（dev 下 Strict Mode 可能调用两次），
  // 导致 onLabelsChange 重复触发。
  const optimisticLabelsRef = React.useRef<string[]>(propLabels ?? [])
  const propKey = React.useMemo(() => joinLabelKey(propLabels), [propLabels])
  const lastSentKeyRef = React.useRef<string | null>(null)

  // 会话切换时硬重置，避免上一个会话的乐观状态泄漏到新会话
  //（例如用户在会话 A 切换 `bug` 标签，在 IPC 确认前切换到 B，
  //  不重置会导致 lastSentKeyRef 阻塞 prop 同步，B 短暂显示 A 的标签）。
  React.useEffect(() => {
    const next = propLabels ?? []
    optimisticLabelsRef.current = next
    lastSentKeyRef.current = null
    setOptimisticLabels(next)
    // 故意只依赖 sessionId —— 同一会话内的 prop 变化由下面的 prop 同步 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  React.useEffect(() => {
    // 只有当服务端已经追上（或超过）我们最近一次发送的值时才从 prop 同步，
    // 否则飞行中的 prop 更新会短暂抹去已排队的本地切换。
    // lastSentKeyRef === null 表示没有待处理的本地变更，此时 prop 是权威的。
    if (lastSentKeyRef.current === null || lastSentKeyRef.current === propKey) {
      const next = propLabels ?? []
      optimisticLabelsRef.current = next
      setOptimisticLabels(next)
      lastSentKeyRef.current = null
    }
  }, [propKey, propLabels])

  const appliedLabelIds = React.useMemo(
    () => new Set(optimisticLabels.map(extractLabelId)),
    [optimisticLabels],
  )

  const toggleLabel = React.useCallback((labelId: string) => {
    if (!onLabelsChange) return
    // 从 ref 读取权威最新值，变更 ref，触发回调，最后才 setState。
    // 所有副作用都在 state updater 外部执行，保证每次用户点击只触发一次，
    // 即使在 Strict Mode 的双渲染检查下也是如此。
    const next = toggleLabelInList(optimisticLabelsRef.current, labelId)
    optimisticLabelsRef.current = next
    lastSentKeyRef.current = joinLabelKey(next)
    setOptimisticLabels(next)
    onLabelsChange(next)
  }, [onLabelsChange])

  const share = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as { success: boolean; url?: string; error?: string } | undefined
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      toast.success(t('toast.linkCopied'), {
        description: result.url,
        action: {
          label: t('common.open'),
          onClick: () => window.electronAPI.openUrl(result.url!),
        },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const showInFinder = React.useCallback(() => {
    window.electronAPI.sessionCommand(sessionId, { type: 'showInFinder' })
  }, [sessionId])

  const copyPath = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'copyPath' }) as { success: boolean; path?: string } | undefined
    if (result?.success && result.path) {
      await navigator.clipboard.writeText(result.path)
      toast.success(t('toast.pathCopied'))
    }
  }, [sessionId, t])

  const refreshTitle = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'refreshTitle' }) as { success: boolean; title?: string; error?: string } | undefined
    if (result?.success) {
      toast.success(t('toast.titleRefreshed'), { description: result.title })
    } else {
      toast.error(t('toast.failedToRefreshTitle'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const openInNewPanel = React.useCallback(() => {
    navigate(routes.view.allSessions(sessionId), { newPanel: true })
  }, [sessionId])

  const openSharedInBrowser = React.useCallback(() => {
    if (!sharedUrl) return
    window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

  const copySharedLink = React.useCallback(async () => {
    if (!sharedUrl) return
    await navigator.clipboard.writeText(sharedUrl)
    toast.success(t('toast.linkCopied'))
  }, [sharedUrl, t])

  const updateShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t('chat.shareUpdated'))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t('chat.failedToUpdateShare'), { description: errorMsg })
    }
  }, [sessionId, t])

  const revokeShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t('chat.sharingStopped'))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t('chat.failedToStopSharing'), { description: errorMsg })
    }
  }, [sessionId, t])

  return {
    appliedLabelIds,
    toggleLabel,
    share,
    showInFinder,
    copyPath,
    refreshTitle,
    openInNewPanel,
    openSharedInBrowser,
    copySharedLink,
    updateShare,
    revokeShare,
  }
}
