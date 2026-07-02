/**
 * SessionMenu - 会话操作菜单内容。
 *
 * 用于：
 * - SessionList（“…” 按钮下拉、右键上下文菜单）
 * - ChatPage（桌面端标题下拉菜单；紧凑模式使用 CompactSessionMenu）
 *
 * 通过 useMenuComponents() 渲染，兼容 DropdownMenu 和 ContextMenu。
 * 副作用处理与乐观标签状态来自 useSessionMenuActions，和紧凑抽屉共享，保持行为一致。
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  Archive,
  ArchiveRestore,
  Trash2,
  Pencil,
  Flag,
  FlagOff,
  MailOpen,
  FolderOpen,
  Copy,
  AppWindow,
  Columns2,
  CloudUpload,
  RefreshCw,
  Tag,
  Send,
  FolderKanban,
  Check,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getStateColor, getStateIcon, type SessionStatusId } from '@/config/session-status-config'
import type { SessionStatus } from '@/config/session-status-config'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { LabelMenuItems, StatusMenuItems, ShareMenuItems } from './SessionMenuParts'
import { getFileManagerName } from '@/lib/platform'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionStatus, hasUnreadMeta, hasMessagesMeta } from '@/utils/session'
import { MessagingSessionMenuItem } from '@/components/messaging/MessagingSessionMenuItem'
import { useSessionMenuActions } from '@/hooks/useSessionMenuActions'

/** SessionMenu 项目选项类型 */
export interface SessionMenuProjectOption {
  id: string
  slug: string
  name: string
}

/** SessionMenuProps：组件 props 类型定义 */
export interface SessionMenuProps {
  /** 会话数据，显示状态从这里派生 */
  item: SessionMeta
  /** 可用工作状态列表 */
  sessionStatuses: SessionStatus[]
  /** 可用标签配置树，用于标签子菜单 */
  labels?: LabelConfig[]
  /** 标签切换回调，收到完整的更新后标签数组 */
  onLabelsChange?: (labels: string[]) => void
  /** 是否存在多个工作区（为 true 时启用“发送到工作区”） */
  hasRemoteWorkspaces?: boolean
  /** 工作区项目列表（省略时隐藏项目子菜单） */
  projects?: SessionMenuProjectOption[]
  /** 绑定/解绑会话到项目的回调。`null` 表示解绑。 */
  onSetProjectId?: (projectId: string | null) => void
  /** 回调 */
  onRename: () => void
  onFlag: () => void
  onUnflag: () => void
  onArchive: () => void
  onUnarchive: () => void
  onMarkUnread: () => void
  onSessionStatusChange: (state: SessionStatusId) => void
  onOpenInNewWindow: () => void
  onSendToWorkspace?: () => void
  onDelete: () => void
}

/**
 * SessionMenu - 渲染会话操作菜单项。
 * 只返回菜单内容，不包裹 DropdownMenu。
 */
export function SessionMenu({
  item,
  sessionStatuses,
  labels = [],
  onLabelsChange,
  onRename,
  onFlag,
  onUnflag,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onSessionStatusChange,
  onOpenInNewWindow,
  onSendToWorkspace,
  onDelete,
  hasRemoteWorkspaces,
  projects = [],
  onSetProjectId,
}: SessionMenuProps) {
  const { t } = useTranslation()

  const sessionId = item.id
  const isFlagged = item.isFlagged ?? false
  const isArchived = item.isArchived ?? false
  const sharedUrl = item.sharedUrl
  const currentSessionStatus = getSessionStatus(item)
  const sessionLabels = item.labels ?? []
  const _hasMessages = hasMessagesMeta(item)
  const _hasUnread = hasUnreadMeta(item)

  const actions = useSessionMenuActions({ item, onLabelsChange })

  // 从上下文获取菜单组件（兼容 DropdownMenu 和 ContextMenu）
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()

  return (
    <>
      {/* 分享/已分享：根据 sharedUrl 状态切换 */}
      {!sharedUrl ? (
        <MenuItem onClick={actions.share}>
          <CloudUpload className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.share")}</span>
        </MenuItem>
      ) : (
        <Sub>
          <SubTrigger className="pr-2">
            <CloudUpload className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sessionMenu.shared")}</span>
          </SubTrigger>
          <SubContent>
            <ShareMenuItems
              onOpenInBrowser={actions.openSharedInBrowser}
              onCopyLink={actions.copySharedLink}
              onUpdateShare={actions.updateShare}
              onRevokeShare={actions.revokeShare}
              menu={{ MenuItem, Separator }}
            />
          </SubContent>
        </Sub>
      )}

      {/* 发送到工作区——存在其它工作区时显示 */}
      {hasRemoteWorkspaces && onSendToWorkspace && (
        <MenuItem onClick={onSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      {/* 连接消息平台——配对码流程 */}
      <MessagingSessionMenuItem sessionId={sessionId} />

      <Separator />

      {/* 状态子菜单 */}
      <Sub>
        <SubTrigger className="pr-2">
          <span style={{ color: getStateColor(currentSessionStatus, sessionStatuses) ?? 'var(--foreground)' }}>
            {(() => {
              const icon = getStateIcon(currentSessionStatus, sessionStatuses)
              return React.isValidElement(icon)
                ? React.cloneElement(icon as React.ReactElement<{ bare?: boolean }>, { bare: true })
                : icon
            })()}
          </span>
          <span className="flex-1">{t("sessionMenu.status")}</span>
        </SubTrigger>
        <SubContent>
          <StatusMenuItems
            sessionStatuses={sessionStatuses}
            activeStateId={currentSessionStatus}
            onSelect={onSessionStatusChange}
            menu={{ MenuItem }}
          />
        </SubContent>
      </Sub>

      {/* 标签子菜单——层级树，带嵌套子菜单和勾选 */}
      {labels.length > 0 && (
        <Sub>
          <SubTrigger className="pr-2">
            <Tag className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sessionMenu.labels")}</span>
            {sessionLabels.length > 0 && (
              <span className="text-[10px] text-muted-foreground tabular-nums -mr-2.5">
                {sessionLabels.length}
              </span>
            )}
          </SubTrigger>
          <SubContent>
            <LabelMenuItems
              labels={labels}
              appliedLabelIds={actions.appliedLabelIds}
              onToggle={actions.toggleLabel}
              menu={{ MenuItem, Separator, Sub, SubTrigger, SubContent }}
            />
          </SubContent>
        </Sub>
      )}

      {/* 项目子菜单——工作区项目 + “无项目”用于清除绑定 */}
      {projects.length > 0 && onSetProjectId && (
        <Sub>
          <SubTrigger className="pr-2">
            <FolderKanban className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sessionMenu.projects")}</span>
          </SubTrigger>
          <SubContent>
            <MenuItem onClick={() => onSetProjectId(null)}>
              {!item.projectId && <Check className="h-3.5 w-3.5" />}
              <span className={item.projectId ? 'flex-1 ml-[18px]' : 'flex-1'}>
                {t("sessionMenu.noProject")}
              </span>
            </MenuItem>
            <Separator />
            {projects.map((p) => {
              const isBound = item.projectId === p.id
              return (
                <MenuItem key={p.id} onClick={() => onSetProjectId(p.id)}>
                  {isBound && <Check className="h-3.5 w-3.5" />}
                  <span className={isBound ? 'flex-1' : 'flex-1 ml-[18px]'}>{p.name}</span>
                </MenuItem>
              )
            })}
          </SubContent>
        </Sub>
      )}

      {/* 标记 / 取消标记 */}
      {!isFlagged ? (
        <MenuItem onClick={onFlag}>
          <Flag className="h-3.5 w-3.5 text-info" />
          <span className="flex-1">{t("sessionMenu.flag")}</span>
        </MenuItem>
      ) : (
        <MenuItem onClick={onUnflag}>
          <FlagOff className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.unflag")}</span>
        </MenuItem>
      )}

      {/* 归档 / 取消归档 */}
      {!isArchived ? (
        <MenuItem onClick={onArchive}>
          <Archive className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.archive")}</span>
        </MenuItem>
      ) : (
        <MenuItem onClick={onUnarchive}>
          <ArchiveRestore className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.unarchive")}</span>
        </MenuItem>
      )}

      {/* 标为未读——仅当会话有消息且当前不是未读时显示 */}
      {!_hasUnread && _hasMessages && (
        <MenuItem onClick={onMarkUnread}>
          <MailOpen className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.markAsUnread")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* 重命名 */}
      <MenuItem onClick={onRename}>
        <Pencil className="h-3.5 w-3.5" />
        <span className="flex-1">{t("common.rename")}</span>
      </MenuItem>

      {/* 重新生成标题——基于最近消息 AI 生成 */}
      <MenuItem onClick={actions.refreshTitle}>
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.regenerateTitle")}</span>
      </MenuItem>

      <Separator />

      {/* 在新面板打开 */}
      <MenuItem onClick={actions.openInNewPanel}>
        <Columns2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.openInNewPanel")}</span>
      </MenuItem>

      {/* 在新窗口打开 */}
      <MenuItem onClick={onOpenInNewWindow}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.openInNewWindow")}</span>
      </MenuItem>

      {/* 在文件管理器中显示 */}
      <MenuItem onClick={actions.showInFinder}>
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.showInFileManager", { fileManager: getFileManagerName() })}</span>
      </MenuItem>

      {/* 复制路径 */}
      <MenuItem onClick={actions.copyPath}>
        <Copy className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.copyPath")}</span>
      </MenuItem>

      <Separator />

      {/* 删除 */}
      <MenuItem onClick={onDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("common.delete")}</span>
      </MenuItem>
    </>
  )
}
