/**
 * EntityList — 可滚动实体列表容器
 *
 * 负责渲染 EntityRow 的通用容器，处理：
 * - ScrollArea 包裹与内边距
 * - 可选分组布局与分组标题
 * - 可折叠分组（ Chevron 切换 + 折叠时显示数量）
 * - 空状态居中展示（在 ScrollArea 外部）
 * - header（如搜索栏）与 footer（如无限滚动锚点）插槽
 *
 * 业务逻辑（过滤、键盘导航、多选）由调用方维护。
 */

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from '@/components/ui/styled-context-menu'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

/** EntityListGroup：类型定义 */
export interface EntityListGroup<T> {
  /** 分组唯一 key */
  key: string
  /** 分组标题 */
  label: string
  /** 该分组下的条目（折叠占位组传空数组，真正条目由调用方过滤） */
  items: T[]
  /** 是否支持折叠/展开（默认 false） */
  collapsible?: boolean
  /** 折叠后隐藏的数量，用于占位组显示 */
  collapsedCount?: number
}

/** EntityListProps：组件 props 类型定义 */
export interface EntityListProps<T> {
  /** 平铺列表（未分组时使用） */
  items?: T[]
  /** 分组列表（优先级高于 items） */
  groups?: EntityListGroup<T>[]
  /** 每个条目的渲染函数 */
  renderItem: (item: T, index: number, isFirstInGroup: boolean) => React.ReactNode
  /** 唯一 key 提取器 */
  getKey: (item: T) => string
  /** 空状态内容 — 在 ScrollArea 外部居中渲染 */
  emptyState?: React.ReactNode
  /** 列表上方内容（如搜索栏）— 在 ScrollArea 外部 */
  header?: React.ReactNode
  /** 列表末尾内容（如无限滚动锚点）— 在 ScrollArea 内部 */
  footer?: React.ReactNode
  /** 内部列表容器的 ref（用于键盘导航聚焦区） */
  containerRef?: React.Ref<HTMLDivElement>
  /** 展开到内部列表容器上的属性（role、aria-label、data-focus-zone 等） */
  containerProps?: Record<string, string>
  /** ScrollArea 视口 ref（用于基于滚动的分页） */
  viewportRef?: React.RefObject<HTMLDivElement>
  /** ScrollArea 额外 className */
  scrollAreaClassName?: string
  /** 外层容器额外 className */
  className?: string
  /** 已折叠分组的 key 集合 */
  collapsedGroups?: Set<string>
  /** 点击可折叠分组标题时触发 */
  onToggleCollapse?: (groupKey: string) => void
  /** 折叠所有可折叠分组 */
  onCollapseAll?: () => void
  /** 展开所有可折叠分组 */
  onExpandAll?: () => void
}

// ============================================================================
// 分组标题
// ============================================================================

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-4 py-2">
      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
    </div>
  )
}

/** 可折叠分组标题：带 Chevron 切换，折叠时显示隐藏数量 */
function CollapsibleGroupHeader({
  label,
  isCollapsed,
  itemCount,
  onToggle,
  onCollapseAll,
  onExpandAll,
}: {
  label: string
  isCollapsed: boolean
  itemCount: number
  onToggle: () => void
  onCollapseAll?: () => void
  onExpandAll?: () => void
}) {
  return (
    <ContextMenu modal>
      <ContextMenuTrigger asChild>
        <button
          onClick={onToggle}
          className="w-full py-2 px-4 flex items-center gap-1.5 cursor-pointer group/header relative"
        >
          <div className="absolute inset-y-0.5 left-2 right-2 rounded-[6px] group-hover/header:bg-foreground/2 transition-colors pointer-events-none" />
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/60 transition-transform relative",
              !isCollapsed && "rotate-90"
            )}
          />
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground relative">
            {label}{isCollapsed && <> · <span className="text-muted-foreground/50">{itemCount}</span></>}
          </span>
        </button>
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <StyledContextMenuItem onClick={onToggle}>
          {isCollapsed ? 'Expand' : 'Collapse'}
        </StyledContextMenuItem>
        <StyledContextMenuSeparator />
        <StyledContextMenuItem onClick={onCollapseAll}>
          Collapse All
        </StyledContextMenuItem>
        <StyledContextMenuItem onClick={onExpandAll}>
          Expand All
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

// ============================================================================
// 组件
// ============================================================================

/** 实体列表组件 */
export function EntityList<T>({
  items,
  groups,
  renderItem,
  getKey,
  emptyState,
  header,
  footer,
  containerRef,
  containerProps,
  viewportRef,
  scrollAreaClassName,
  className,
  collapsedGroups,
  onToggleCollapse,
  onCollapseAll,
  onExpandAll,
}: EntityListProps<T>) {
  // 判断是否有内容
  const hasGroups = groups && groups.length > 0
  const hasItems = items && items.length > 0
  const isEmpty = !hasGroups && !hasItems

  // 空状态在 ScrollArea 外部渲染，以便正确居中
  if (isEmpty && emptyState) {
    return (
      <div className={cn('flex flex-col flex-1', className)}>
        {header}
        {emptyState}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      {header}
      <ScrollArea className={cn('flex-1', scrollAreaClassName)} viewportRef={viewportRef}>
        <div
          ref={containerRef}
          className="flex flex-col pb-2"
          {...containerProps}
        >
          <div className="pt-1">
            {hasGroups
              ? groups!.map((group) => {
                  const isCollapsed = group.collapsible && collapsedGroups?.has(group.key)

                  return (
                    <div key={group.key}>
                      {group.collapsible && onToggleCollapse ? (
                        <CollapsibleGroupHeader
                          label={group.label}
                          isCollapsed={!!isCollapsed}
                          itemCount={isCollapsed ? (group.collapsedCount ?? 0) : group.items.length}
                          onToggle={() => onToggleCollapse(group.key)}
                          onCollapseAll={onCollapseAll}
                          onExpandAll={onExpandAll}
                        />
                      ) : (
                        <SectionHeader label={group.label} />
                      )}
                      {group.items.map((item, indexInGroup) =>
                        <React.Fragment key={getKey(item)}>
                          {renderItem(item, indexInGroup, indexInGroup === 0)}
                        </React.Fragment>
                      )}
                    </div>
                  )
                })
              : items?.map((item, index) =>
                  <React.Fragment key={getKey(item)}>
                    {renderItem(item, index, index === 0)}
                  </React.Fragment>
                )
            }
          </div>
          {footer}
        </div>
      </ScrollArea>
    </div>
  )
}
