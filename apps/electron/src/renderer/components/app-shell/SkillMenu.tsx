/**
 * SkillMenu - 技能操作菜单内容。
 *
 * 用于：
 * - SkillsListPanel（“…” 按钮下拉菜单、右键上下文菜单）
 * - SkillInfoPage（标题下拉菜单）
 *
 * 通过 MenuComponents 上下文渲染，兼容 DropdownMenu 和 ContextMenu。
 *
 * 提供的操作：
 * - 在新窗口打开
 * - 在文件管理器中显示
 * - 删除
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  Trash2,
  FolderOpen,
  AppWindow,
  Send,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getFileManagerName } from '@/lib/platform'

/** SkillMenuProps：组件 props 类型定义 */
export interface SkillMenuProps {
  /** 技能 slug */
  skillSlug: string
  /** 技能名称，用于显示 */
  skillName: string
  /** 回调 */
  onOpenInNewWindow: () => void
  onShowInFinder: () => void | Promise<void>
  onDelete?: () => void
  canShowInFinder?: boolean
  canDelete?: boolean
  deleteLabel?: string
  /** 发送到其它工作区（不传则隐藏该选项） */
  onSendToWorkspace?: () => void
}

/**
 * SkillMenu - 渲染技能操作菜单项。
 * 只返回菜单内容，不包裹 DropdownMenu 或 ContextMenu。
 */
export function SkillMenu({
  skillSlug,
  skillName,
  onOpenInNewWindow,
  onShowInFinder,
  onDelete,
  canShowInFinder = true,
  canDelete = true,
  deleteLabel,
  onSendToWorkspace,
}: SkillMenuProps) {
  const { t } = useTranslation()

  // 从上下文获取菜单组件（兼容 DropdownMenu 和 ContextMenu）
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {/* 在新窗口打开 */}
      <MenuItem onClick={onOpenInNewWindow}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>

      {/* 在文件管理器中显示 */}
      <MenuItem onClick={onShowInFinder} disabled={!canShowInFinder}>
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.showInFileManager", { fileManager: getFileManagerName() })}</span>
      </MenuItem>

      {/* 发送到其它工作区 */}
      {onSendToWorkspace && (
        <MenuItem onClick={onSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* 删除 */}
      <MenuItem onClick={canDelete ? onDelete : undefined} variant="destructive" disabled={!canDelete}>
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{deleteLabel || t("sidebarMenu.deleteSkill")}</span>
      </MenuItem>
    </>
  )
}
