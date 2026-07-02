/**
 * SourceMenu - 来源操作菜单内容。
 *
 * 用于：
 * - SourcesListPanel（“…” 按钮下拉菜单、右键上下文菜单）
 * - SourceInfoPage（标题下拉菜单）
 *
 * 通过 MenuComponents 上下文渲染，因此同一套内容既能用于 DropdownMenu，也能用于 ContextMenu。
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

/** SourceMenuProps：组件 props 类型定义 */
export interface SourceMenuProps {
  /** 来源 slug */
  sourceSlug: string
  /** 来源名称，用于显示 */
  sourceName: string
  /** 回调 */
  onOpenInNewWindow: () => void
  onShowInFinder: () => void
  onDelete: () => void
  /** 发送到其它工作区（不传则隐藏该选项） */
  onSendToWorkspace?: () => void
}

/**
 * SourceMenu - 渲染来源操作菜单项。
 * 只返回菜单内容，不包裹 DropdownMenu 或 ContextMenu。
 */
export function SourceMenu({
  sourceSlug,
  sourceName,
  onOpenInNewWindow,
  onShowInFinder,
  onDelete,
  onSendToWorkspace,
}: SourceMenuProps) {
  const { t } = useTranslation()

  // 从上下文获取菜单组件（同时兼容 DropdownMenu 和 ContextMenu）
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {/* 在新窗口打开 */}
      <MenuItem onClick={onOpenInNewWindow}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>

      {/* 在文件管理器中显示 */}
      <MenuItem onClick={onShowInFinder}>
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
      <MenuItem onClick={onDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.deleteSource")}</span>
      </MenuItem>
    </>
  )
}
