/**
 * BatchSessionMenu - 多选会话的右键/批量操作菜单内容。
 *
 * 这是一个自包含组件：通过 hooks 读取选中状态、会话元数据和修改回调，
 * 再通过 useMenuComponents() 渲染与具体菜单容器无关的菜单项，因此既能用于 DropdownMenu，也能用于 ContextMenu。
 *
 * 功能对齐 MultiSelectPanel（状态、标签、归档），并额外提供 Flag（标记）和 Delete（删除）。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Archive, Flag, FlagOff, Trash2, Tag, Send } from 'lucide-react'
import { toast } from 'sonner'
import { useMenuComponents } from '@/components/ui/menu-context'
import { useSelectedIds } from '@/hooks/useSession'
import { useSessionSelection } from '@/hooks/useSession'
import { sessionMetaMapAtom, sendToWorkspaceAtom, type SessionMeta } from '@/atoms/sessions'
import { useAppShellContext } from '@/context/AppShellContext'
import { getStateColor, getStateIcon, type SessionStatusId } from '@/config/session-status-config'
import { extractLabelId } from '@craft-agent/shared/labels'
import { LabelMenuItems, StatusMenuItems } from './SessionMenuParts'

/** BatchSessionMenuProps：组件 props 类型定义 */
export interface BatchSessionMenuProps {
  /** 打开“发送到工作区”对话框的回调 */
  onSendToWorkspace?: () => void
}

/**
 * 批量操作菜单。
 *
 * 自包含组件：通过 hooks 读取选中状态、会话元数据和修改回调，
 * 再通过 useMenuComponents() 渲染与具体菜单容器无关的菜单项。
 */
export function BatchSessionMenu({ onSendToWorkspace }: BatchSessionMenuProps = {}) {
  const { t } = useTranslation()
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()

  const selectedIds = useSelectedIds()
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)
  const { clearMultiSelect } = useSessionSelection()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const {
    onSessionStatusChange,
    onArchiveSession,
    onUnarchiveSession,
    onFlagSession,
    onUnflagSession,
    onSessionLabelsChange,
    onDeleteSession,
    workspaces,
    sessionStatuses = [],
    labels = [],
  } = useAppShellContext()

  const hasRemoteWorkspaces = workspaces?.some(w => w.remoteServer) ?? false

  // 根据选中的 ID 从全局 meta map 里取回完整元数据
  const selectedMetas = useMemo(() => {
    const metas: SessionMeta[] = []
    selectedIds.forEach((id) => {
      const meta = sessionMetaMap.get(id)
      if (meta) metas.push(meta)
    })
    return metas
  }, [selectedIds, sessionMetaMap])

  // 计算“共享状态”：只有当所有选中会话状态一致时才显示，否则显示空占位
  const activeStatusId = useMemo((): SessionStatusId | null => {
    if (selectedMetas.length === 0) return null
    const first = (selectedMetas[0].sessionStatus || 'todo') as SessionStatusId
    const allSame = selectedMetas.every(meta => (meta.sessionStatus || 'todo') === first)
    return allSame ? first : null
  }, [selectedMetas])

  // 计算已应用标签的交集：只有所有选中会话都有的标签才视为已选中
  const appliedLabelIds = useMemo(() => {
    if (selectedMetas.length === 0) return new Set<string>()
    const toLabelSet = (meta: SessionMeta) =>
      new Set((meta.labels || []).map(entry => extractLabelId(entry)))
    const [first, ...rest] = selectedMetas.map(toLabelSet)
    const intersection = new Set(first)
    for (const labelSet of rest) {
      for (const id of [...intersection]) {
        if (!labelSet.has(id)) intersection.delete(id)
      }
    }
    return intersection
  }, [selectedMetas])

  // 标记状态：只有当所有选中会话都被标记时才显示“取消标记”
  const allFlagged = useMemo(
    () => selectedMetas.length > 0 && selectedMetas.every(m => m.isFlagged),
    [selectedMetas]
  )

  // 批量修改状态
  const handleBatchSetStatus = useCallback((status: SessionStatusId) => {
    selectedIds.forEach(sessionId => {
      onSessionStatusChange(sessionId, status)
    })
  }, [selectedIds, onSessionStatusChange])

  // 批量切换标签：采用“全有或全无”语义，和 MainContentPanel 保持一致
  const handleBatchToggleLabel = useCallback((labelId: string) => {
    if (!onSessionLabelsChange) return
    const allHaveLabel = selectedMetas.every(meta =>
      (meta.labels || []).some(entry => extractLabelId(entry) === labelId)
    )
    selectedMetas.forEach(meta => {
      const currentLabels = meta.labels || []
      const hasLabel = currentLabels.some(entry => extractLabelId(entry) === labelId)
      const filtered = currentLabels.filter(entry => extractLabelId(entry) !== labelId)
      const nextLabels = allHaveLabel
        ? filtered
        : (hasLabel ? currentLabels : [...currentLabels, labelId])
      onSessionLabelsChange(meta.id, nextLabels)
    })
  }, [selectedMetas, onSessionLabelsChange])

  // 批量标记 / 取消标记
  const handleBatchFlag = useCallback(() => {
    selectedIds.forEach(id => onFlagSession(id))
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} flagged`)
  }, [selectedIds, onFlagSession])

  const handleBatchUnflag = useCallback(() => {
    selectedIds.forEach(id => onUnflagSession(id))
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} unflagged`)
  }, [selectedIds, onUnflagSession])

  // 批量归档
  const handleBatchArchive = useCallback(() => {
    selectedIds.forEach(id => onArchiveSession(id))
    clearMultiSelect()
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} archived`)
  }, [selectedIds, onArchiveSession, clearMultiSelect])

  // 批量发送到工作区
  const handleSendToWorkspace = useCallback(() => {
    if (onSendToWorkspace) {
      onSendToWorkspace()
    } else {
      setSendToWorkspace([...selectedIds])
    }
  }, [onSendToWorkspace, selectedIds, setSendToWorkspace])

  // 批量删除：第一个弹出确认，确认后再跳过确认删除剩余
  const handleBatchDelete = useCallback(async () => {
    const count = selectedIds.size
    const ids = [...selectedIds]
    const firstDeleted = await onDeleteSession(ids[0])
    if (!firstDeleted) return // 用户取消
    for (let i = 1; i < ids.length; i++) {
      await onDeleteSession(ids[i], true) // 剩余项跳过确认
    }
    clearMultiSelect()
    toast(`${count} ${count === 1 ? 'session' : 'sessions'} deleted`)
  }, [selectedIds, onDeleteSession, clearMultiSelect])

  // 为状态子菜单触发器准备当前共享状态的图标
  const statusIcon = activeStatusId
    ? (() => {
        const icon = getStateIcon(activeStatusId, sessionStatuses)
        return React.isValidElement(icon)
          ? React.cloneElement(icon as React.ReactElement<{ bare?: boolean }>, { bare: true })
          : icon
      })()
    : null

  const count = selectedIds.size

  return (
    <>
      {/* 顶部显示选中数量 */}
      <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
        {t('multiSelect.selected.session', { count })}
      </div>
      <Separator />

      {/* 状态子菜单 */}
      <Sub>
        <SubTrigger className="pr-2">
          {statusIcon ? (
            <span style={{ color: getStateColor(activeStatusId!, sessionStatuses) ?? 'var(--foreground)' }}>
              {statusIcon}
            </span>
          ) : (
            <span className="h-3.5 w-3.5" />
          )}
          <span className="flex-1">{t("sessionMenu.status")}</span>
        </SubTrigger>
        <SubContent>
          <StatusMenuItems
            sessionStatuses={sessionStatuses}
            activeStateId={activeStatusId ?? undefined}
            onSelect={handleBatchSetStatus}
            menu={{ MenuItem }}
          />
        </SubContent>
      </Sub>

      {/* 标签子菜单 */}
      {labels.length > 0 && (
        <Sub>
          <SubTrigger className="pr-2">
            <Tag className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebar.labels")}</span>
          </SubTrigger>
          <SubContent>
            <LabelMenuItems
              labels={labels}
              appliedLabelIds={appliedLabelIds}
              onToggle={handleBatchToggleLabel}
              menu={{ MenuItem, Separator, Sub, SubTrigger, SubContent }}
            />
          </SubContent>
        </Sub>
      )}

      {/* 标记 / 取消标记 */}
      {allFlagged ? (
        <MenuItem onClick={handleBatchUnflag}>
          <FlagOff className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.unflagAll")}</span>
        </MenuItem>
      ) : (
        <MenuItem onClick={handleBatchFlag}>
          <Flag className="h-3.5 w-3.5 text-info" />
          <span className="flex-1">{t("sessionMenu.flagAll")}</span>
        </MenuItem>
      )}

      {/* 归档 */}
      <MenuItem onClick={handleBatchArchive}>
        <Archive className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.archive")}</span>
      </MenuItem>

      {/* 发送到工作区 */}
      {hasRemoteWorkspaces && (
        <MenuItem onClick={handleSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* 删除 */}
      <MenuItem onClick={handleBatchDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("common.delete")}</span>
      </MenuItem>
    </>
  )
}
