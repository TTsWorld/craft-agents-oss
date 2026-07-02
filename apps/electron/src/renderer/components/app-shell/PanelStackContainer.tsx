/**
 * PanelStackContainer
 *
 * 所有面板的横向布局容器：
 * 侧边栏 → 导航面板 → 内容面板（带可拖拽调整宽度的 sash）。
 *
 * 内容面板使用 CSS flex-grow，按 proportion 作为权重分配空间：
 * - 每个面板得到 `flex: <proportion> 1 0px`，并设置 `min-width: PANEL_MIN_WIDTH`
 * - flex 会按比例把剩余空间分完，让面板填满可视区域
 * - 当面板碰到最小宽度时，容器自然出现横向滚动条
 *
 * 侧边栏和导航面板不参与比例布局——它们的宽度由 AppShell 单独管理，
 * 只是占掉内容面板可用的宽度，并随整体一起滚动。
 *
 * 右侧边栏不在这个容器内部。
 *
 * 紧凑模式（移动端 / 窄窗口）：
 * flex 布局被替换为 absolute 定位 + transform 动画的栈：
 * 导航面板和当前聚焦的内容面板都保持挂载，通过 CompactPanelTransition 滑入/滑出，
 * 实现类似 iOS UINavigationController 的转场效果，而不是 CSS 重排。
 */

import { useRef, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { panelStackAtom, focusedPanelIdAtom, focusedPanelRouteAtom } from '@/atoms/panel-stack'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import { isDetailNavState } from '@/lib/nav-helpers'
import { PanelSlot } from './PanelSlot'
import { PanelResizeSash } from './PanelResizeSash'
import { CompactPanelTransition } from './CompactPanelTransition'
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
} from './panel-constants'

/** 弹簧动画参数，与 AppShell 侧边栏/导航面板的动画保持一致 */
const PANEL_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }

/** 紧凑模式下，固定顶部 TopBar 与第一个面板之间的视觉间隙 */
const COMPACT_PANEL_TOP_GAP = 8

interface PanelStackContainerProps {
  sidebarSlot: React.ReactNode
  sidebarWidth: number
  navigatorSlot: React.ReactNode
  navigatorWidth: number
  isSidebarAndNavigatorHidden: boolean
  isRightSidebarVisible?: boolean
  /** 紧凑模式：单面板，列表与内容切换（移动端或窄窗口） */
  isCompact?: boolean
  isResizing?: boolean
}

/** 面板栈容器：根据桌面/紧凑模式渲染不同的布局 */
export function PanelStackContainer({
  sidebarSlot,
  sidebarWidth,
  navigatorSlot,
  navigatorWidth,
  isSidebarAndNavigatorHidden,
  isRightSidebarVisible,
  isCompact = false,
  isResizing,
}: PanelStackContainerProps) {
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const focusedRoute = useAtomValue(focusedPanelRouteAtom)

  const contentPanels = panelStack

  // 紧凑模式下，“进入详情”不只是“选中会话”。
  // 会话：选中了某个会话；设置：选中了某个子页面；
  // sources/skills/automations：选中了某个具体实体。
  const focusedNavState = focusedRoute ? parseRouteToNavigationState(focusedRoute) : null
  const isDetailFocused = isDetailNavState(focusedNavState)
  const hasSelectedContent = isCompact && isDetailFocused

  const visiblePanels = isCompact
    ? contentPanels.filter(e => e.id === focusedPanelId).slice(0, 1)
    : contentPanels

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(contentPanels.length)

  const hasSidebar = sidebarWidth > 0
  // 桌面端：按 AppShell 给的 navigatorWidth 决定是否显示导航面板。
  // 紧凑模式：导航面板始终挂载；当聚焦详情时通过 transform 隐藏，保证两侧同步滑入/滑出。
  const hasNavigator = isCompact ? navigatorWidth > 0 : navigatorWidth > 0
  const isMultiPanel = visiblePanels.length > 1
  const isLeftEdge = !hasSidebar && !hasNavigator

  // 桌面多面板时，新增内容面板后自动滚动到最右侧。
  // 紧凑模式是单面板，不需要滚动进视野。
  useEffect(() => {
    if (contentPanels.length > prevCountRef.current && scrollRef.current && !isCompact) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          left: scrollRef.current.scrollWidth,
          behavior: 'smooth',
        })
      })
    }
    prevCountRef.current = contentPanels.length
  }, [contentPanels.length, isCompact])

  const transition = (isResizing || isCompact) ? { duration: 0 } : PANEL_SPRING

  // === 紧凑模式分支 ===
  // 单面板布局，导航面板和详情面板像 iOS 一样左右滑动切换。
  // 两者都保留在 DOM 中，CompactPanelTransition 负责把不在当前屏的面板移出可视区。
  // 紧凑模式下侧边栏由 AppShell 隐藏（sidebarWidth = 0）。
  if (isCompact) {
    const focusedEntry = visiblePanels[0]
    return (
      <div
        ref={scrollRef}
        data-mobile-menu-root="true"
        className="flex-1 min-w-0 relative panel-scroll @container/shell"
        style={{
          paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
          marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
          marginBottom: -6,
          paddingBottom: 6,
          '--compact-panel-stack-top': `${PANEL_STACK_VERTICAL_OVERFLOW + COMPACT_PANEL_TOP_GAP}px`,
        } as React.CSSProperties}
      >
        {/* 导航面板插槽：全宽；进入详情时向左滑出到 -30% */}
        {hasNavigator && (
          <CompactPanelTransition role="navigator" isDetailActive={hasSelectedContent}>
            <div
              data-panel-role="navigator"
              className={cn(
                'h-full w-full overflow-hidden relative',
                'bg-background shadow-middle',
              )}
              style={{
                // 紧凑模式下贴底，底部不需要圆角
                borderTopLeftRadius: RADIUS_INNER,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: RADIUS_INNER,
                borderBottomRightRadius: 0,
              }}
            >
              {navigatorSlot}
            </div>
          </CompactPanelTransition>
        )}

        {/* 内容面板插槽：全宽；进入详情时从右侧滑入 */}
        {focusedEntry && (
          <CompactPanelTransition role="detail" isDetailActive={hasSelectedContent}>
            <div className="h-full w-full flex">
              <PanelSlot
                key={focusedEntry.id}
                entry={focusedEntry}
                isOnly={true}
                isFocusedPanel={true}
                isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
                isAtLeftEdge={isLeftEdge}
                isAtRightEdge={!isRightSidebarVisible}
                proportion={focusedEntry.proportion}
                isCompact={true}
              />
            </div>
          </CompactPanelTransition>
        )}
      </div>
    )
  }

  // === 桌面模式分支 ===
  // 保持之前的 flex 横向布局，行为不变。
  return (
    <div
      ref={scrollRef}
      data-mobile-menu-root="true"
      className="flex-1 min-w-0 flex relative z-panel panel-scroll @container/shell"
      style={{
        overflowX: 'auto',
        overflowY: 'hidden',
        paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
        marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
        marginBottom: -6,
        paddingBottom: 6,
        paddingRight: 8,
        marginRight: -8,
      }}
    >
      <motion.div
        className="flex h-full"
        initial={false}
        animate={{ paddingLeft: !hasSidebar ? PANEL_EDGE_INSET : 0 }}
        transition={transition}
        style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: 0 }}
      >
        {/* === 侧边栏插槽 === */}
        <motion.div
          data-panel-role="sidebar"
          initial={false}
          animate={{
            width: hasSidebar ? sidebarWidth : 0,
            marginRight: hasSidebar ? 0 : -PANEL_GAP,
            opacity: hasSidebar ? 1 : 0,
          }}
          transition={transition}
          className="h-full relative shrink-0"
          style={{ overflowX: 'clip', overflowY: 'visible' }}
        >
          <div className="h-full" style={{ width: sidebarWidth }}>
            {sidebarSlot}
          </div>
        </motion.div>

        {/* === 导航面板插槽 === */}
        <motion.div
          data-panel-role="navigator"
          initial={false}
          animate={{
            width: hasNavigator ? navigatorWidth : 0,
            marginRight: hasNavigator ? 0 : -PANEL_GAP,
            opacity: hasNavigator ? 1 : 0,
          }}
          transition={transition}
          className={cn(
            'h-full overflow-hidden relative shrink-0 z-[2]',
            'bg-background shadow-middle',
          )}
          style={{
            borderTopLeftRadius: RADIUS_INNER,
            borderBottomLeftRadius: !hasSidebar ? RADIUS_EDGE : RADIUS_INNER,
            borderTopRightRadius: RADIUS_INNER,
            borderBottomRightRadius: RADIUS_INNER,
          }}
        >
          <div className="h-full" style={{ width: navigatorWidth }}>
            {navigatorSlot}
          </div>
        </motion.div>

        {/* === 内容面板与调整宽度 sash === */}
        {visiblePanels.length === 0 ? (
          <div className="flex-1 flex items-center justify-center" />
        ) : (
          visiblePanels.map((entry, index) => (
            <PanelSlot
              key={entry.id}
              entry={entry}
              isOnly={visiblePanels.length === 1}
              isFocusedPanel={isMultiPanel ? entry.id === focusedPanelId : true}
              isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
              isAtLeftEdge={index === 0 && isLeftEdge}
              isAtRightEdge={index === visiblePanels.length - 1 && !isRightSidebarVisible}
              proportion={entry.proportion}
              isCompact={false}
              sash={index > 0 ? (
                <PanelResizeSash
                  leftIndex={index - 1}
                  rightIndex={index}
                />
              ) : undefined}
            />
          ))
        )}
      </motion.div>
    </div>
  )
}
