/**
 * NavigatorPanel - 列表导航用的中间面板组件
 *
 * 结构：顶部一个固定标题栏（可带操作按钮），下方是滚动内容区。
 * 常见子节点是 SessionList（会话列表）或 SourcesListPanel（来源列表）。
 *
 * 布局：
 * ┌────────────────────────────┐
 * │ 标题栏（+ 操作按钮）        │
 * ├────────────────────────────┤
 * │                            │
 * │   子节点（列表内容）        │
 * │                            │
 * └────────────────────────────┘
 */

import * as React from 'react'
import { Panel } from './Panel'
import { PanelHeader } from './PanelHeader'
import { cn } from '@/lib/utils'

/** NavigatorPanelProps：组件 props 类型定义 */
export interface NavigatorPanelProps {
  /** 面板标题，例如 "Conversations"、"Sources" */
  title: string
  /** 面板固定宽度（像素） */
  width: number
  /** 标题栏右侧的操作按钮，例如筛选、新增 */
  headerActions?: React.ReactNode
  /** 主内容区，例如 SessionList、SourcesListPanel */
  children: React.ReactNode
  /** 容器额外的 CSS 类名 */
  className?: string
}

/**
 * 中间列导航面板，组合 Panel + PanelHeader + 滚动内容。
 */
export function NavigatorPanel({
  title,
  width,
  headerActions,
  children,
  className,
}: NavigatorPanelProps) {
  return (
    <Panel variant="shrink" width={width} className={className}>
      <PanelHeader
        title={title}
        actions={headerActions}
      />
      {children}
    </Panel>
  )
}
