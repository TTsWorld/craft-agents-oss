/**
 * DataTableOverlay - 用于查看数据表的全屏/模态浮层
 *
 * 以 PreviewOverlay 为基础，保证一致的模态/全屏行为。
 * 渲染子内容（通常为数据表）时无滚动约束，
 * 允许在展开视图中完整展示表格。
 */

import * as React from 'react'
import type { ReactNode } from 'react'
import { Table2 } from 'lucide-react'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'

export interface DataTableOverlayProps {
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 浮层头部标题（如"权限"、"工具"） */
  title: string
  /** 可选副标题（如行数） */
  subtitle?: string
  /** 暗色/亮色主题模式（默认 'light'） */
  theme?: 'light' | 'dark'
  /** 头部徽标变体（默认：gray） */
  badgeVariant?: BadgeVariant
  /** 显示在头部右侧的操作（如复制下拉菜单） */
  headerActions?: ReactNode
  /** 要渲染的数据表内容 */
  children: ReactNode
}

export function DataTableOverlay({
  isOpen,
  onClose,
  title,
  subtitle,
  theme,
  badgeVariant = 'gray',
  headerActions,
  children,
}: DataTableOverlayProps) {
  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Table2,
        label: 'Table',
        variant: badgeVariant,
      }}
      title={title}
      subtitle={subtitle}
      headerActions={headerActions}
    >
      {/* 表格内容——滚动由父级浮层的滚动容器处理 */}
      <div>
        {children}
      </div>
    </PreviewOverlay>
  )
}
