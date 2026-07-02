/**
 * SidebarMenu - 侧边栏导航项的共享菜单内容。
 *
 * 用于：
 * - LeftSidebar（导航项右键上下文菜单）
 * - AppShell（新建聊天按钮的上下文菜单）
 *
 * 通过 MenuComponents 上下文渲染，兼容 DropdownMenu 和 ContextMenu。
 *
 * 根据侧边栏项类型提供不同操作：
 * - “配置状态”（allSessions/status/flagged）
 * - “添加来源”（sources）
 * - “添加技能”（skills）
 * - “添加自动化”（automations）
 * - “在新窗口打开”（仅 newSession）
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  AppWindow,
  CheckCheck,
  Settings2,
  Plus,
  Trash2,
  ExternalLink,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getDocUrl, type DocFeature } from '@craft-agent/shared/docs/doc-links'

/** SidebarMenuType：侧边栏菜单类型 */
export type SidebarMenuType = 'allSessions' | 'flagged' | 'status' | 'sources' | 'skills' | 'automations' | 'projects' | 'labels' | 'views' | 'newSession'

/** SidebarMenuProps：组件 props 类型定义 */
export interface SidebarMenuProps {
  /** 侧边栏项类型，决定显示哪些菜单项 */
  type: SidebarMenuType
  /** 状态项的状态 ID（例如 'todo'、'done'），目前未使用但保留 */
  statusId?: string
  /** 标签 ID；设置时表示这是单个标签项，可启用“删除标签” */
  labelId?: string
  /** “配置状态”回调，仅用于 allSessions/status/flagged 类型 */
  onConfigureStatuses?: () => void
  /** “全部标为已读”回调，仅用于 allSessions 类型 */
  onMarkAllRead?: () => void
  /** “配置标签”回调；从具体标签触发时会传入 labelId */
  onConfigureLabels?: (labelId?: string) => void
  /** “新增标签”回调；parentId 为 labelId（如果有） */
  onAddLabel?: (parentId?: string) => void
  /** “删除标签”回调 */
  onDeleteLabel?: (labelId: string) => void
  /** “添加来源”回调，仅用于 sources 类型 */
  onAddSource?: () => void
  /** “添加技能”回调，仅用于 skills 类型 */
  onAddSkill?: () => void
  /** “添加自动化”回调，仅用于 automations 类型 */
  onAddAutomation?: () => void
  /** “添加项目”回调，仅用于 projects 类型 */
  onAddProject?: () => void
  /** 来源类型过滤，决定“了解更多”打开哪个文档页 */
  sourceType?: 'api' | 'mcp' | 'local'
  /** “编辑视图”回调，用于 views 类型 */
  onConfigureViews?: () => void
  /** 视图 ID；设置时表示单个视图，可启用删除 */
  viewId?: string
  /** “删除视图”回调 */
  onDeleteView?: (id: string) => void
}

/**
 * SidebarMenu - 渲染侧边栏导航操作菜单项。
 * 只返回菜单内容，不包裹 DropdownMenu 或 ContextMenu。
 */
export function SidebarMenu({
  type,
  statusId,
  labelId,
  onConfigureStatuses,
  onMarkAllRead,
  onConfigureLabels,
  onAddLabel,
  onDeleteLabel,
  onAddSource,
  onAddSkill,
  onAddAutomation,
  onAddProject,
  sourceType,
  onConfigureViews,
  viewId,
  onDeleteView,
}: SidebarMenuProps) {
  const { t } = useTranslation()

  // 从上下文获取菜单组件（兼容 DropdownMenu 和 ContextMenu）
  const { MenuItem, Separator } = useMenuComponents()

  // New Session：只显示“在新窗口打开”
  if (type === 'newSession') {
    return (
      <MenuItem onClick={() => window.electronAPI.openUrl('craftagents://action/new-session?window=focused')}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>
    )
  }

  // All Sessions / Status / Flagged：显示“配置状态”（allSessions 额外显示“全部标为已读”）
  if ((type === 'allSessions' || type === 'status' || type === 'flagged') && onConfigureStatuses) {
    return (
      <>
        {type === 'allSessions' && onMarkAllRead && (
          <>
            <MenuItem onClick={onMarkAllRead}>
              <CheckCheck className="h-3.5 w-3.5" />
              <span className="flex-1">{t("sidebarMenu.markAllRead")}</span>
            </MenuItem>
            <Separator />
          </>
        )}
        <MenuItem onClick={onConfigureStatuses}>
          <Settings2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sidebarMenu.configureStatuses")}</span>
        </MenuItem>
      </>
    )
  }

  // Labels：根据上下文显示不同操作
  // - 标题（Labels 父级）：配置标签 + 新增标签
  // - 单个标签项：新增子标签 + 删除标签
  if (type === 'labels') {
    return (
      <>
        {onAddLabel && (
          <MenuItem onClick={() => onAddLabel(labelId)}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addNewLabel")}</span>
          </MenuItem>
        )}
        {onConfigureLabels && (
          <MenuItem onClick={() => onConfigureLabels(labelId)}>
            <Settings2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.editLabels")}</span>
          </MenuItem>
        )}
        {labelId && onDeleteLabel && (
          <>
            <Separator />
            <MenuItem onClick={() => onDeleteLabel(labelId)}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="flex-1">{t("sidebarMenu.deleteLabel")}</span>
            </MenuItem>
          </>
        )}
      </>
    )
  }

  // Views：显示“编辑视图”和可选的“删除视图”
  if (type === 'views') {
    return (
      <>
        {onConfigureViews && (
          <MenuItem onClick={onConfigureViews}>
            <Settings2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.editViews")}</span>
          </MenuItem>
        )}
        {viewId && onDeleteView && (
          <>
            <Separator />
            <MenuItem onClick={() => onDeleteView(viewId)}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="flex-1">{t("sidebarMenu.deleteView")}</span>
            </MenuItem>
          </>
        )}
      </>
    )
  }

  // Sources：显示“添加来源”和“了解更多”
  if (type === 'sources') {
    // 根据来源类型过滤决定打开哪个文档页
    const docFeature: DocFeature = sourceType
      ? `sources-${sourceType}` as DocFeature
      : 'sources'

    // 根据来源类型变化显示标签
    const learnMoreLabel = sourceType === 'api'
      ? t('sidebarMenu.learnMoreApis')
      : sourceType === 'mcp'
        ? t('sidebarMenu.learnMoreMcp')
        : sourceType === 'local'
          ? t('sidebarMenu.learnMoreLocalFolders')
          : t('sidebarMenu.learnMoreSources')

    return (
      <>
        {onAddSource && (
          <MenuItem onClick={onAddSource}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addSource")}</span>
          </MenuItem>
        )}
        <Separator />
        <MenuItem onClick={() => window.electronAPI.openUrl(getDocUrl(docFeature))}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{learnMoreLabel}</span>
        </MenuItem>
      </>
    )
  }

  // Skills：显示“添加技能”
  if (type === 'skills' && onAddSkill) {
    return (
      <MenuItem onClick={onAddSkill}>
        <Plus className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.addSkill")}</span>
      </MenuItem>
    )
  }

  // Projects：显示“添加项目”
  if (type === 'projects') {
    return (
      <>
        {onAddProject && (
          <MenuItem onClick={onAddProject}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addProject")}</span>
          </MenuItem>
        )}
      </>
    )
  }

  // Automations：显示“添加自动化”和“了解更多”
  if (type === 'automations') {
    return (
      <>
        {onAddAutomation && (
          <MenuItem onClick={onAddAutomation}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addAutomation")}</span>
          </MenuItem>
        )}
        <Separator />
        <MenuItem onClick={() => window.electronAPI.openUrl(getDocUrl('automations'))}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sidebarMenu.learnMoreAutomations")}</span>
        </MenuItem>
      </>
    )
  }

  // 兜底：没有匹配到任何处理函数时返回 null（正常不应发生）
  return null
}
