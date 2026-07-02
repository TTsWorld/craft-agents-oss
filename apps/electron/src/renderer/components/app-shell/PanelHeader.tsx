/**
 * PanelHeader - 面板的标准化顶部标题栏组件
 *
 * 提供一致的标题栏样式与行为：
 * - 固定 42px 高度
 * - 标题 + 可选徽章
 * - 可选右侧操作按钮
 * - 可选标题下拉菜单（传入 titleMenu 时标题变成可点击）
 * - 自动为 macOS 左上角红绿灯留出边距（通过 StoplightContext）
 *
 * 用法：
 * ```tsx
 * <PanelHeader
 *   title="会话"
 *   actions={<Button>新增</Button>}
 * />
 *
 * // 带交互式标题菜单：
 * <PanelHeader
 *   title="聊天名称"
 *   titleMenu={<><MenuItem>重命名</MenuItem><MenuItem>删除</MenuItem></>}
 * />
 * ```
 *
 * 当该组件位于 StoplightProvider 内时会自动补偿红绿灯区域；
 * 也可以用 compensateForStoplight prop 显式控制。
 */

import * as React from 'react'
import { useState } from 'react'
import { motion } from 'motion/react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCompensateForStoplight } from '@/context/StoplightContext'
import { useAppShellContext } from '@/context/AppShellContext'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent } from '@/components/ui/styled-dropdown'

// 弹性动画参数，和侧边栏保持一致
const springTransition = { type: 'spring' as const, stiffness: 300, damping: 30 }

// 为 macOS 左上角红绿灯预留的左侧边距（红绿灯宽约 52px，间距约 14px）
const STOPLIGHT_PADDING = 84

// 紧凑模式下控制按钮的尺寸与间距：
// 按钮 44px、间距 6px，额外为标题留出空间，
// 这样长标题会在碰到右侧按钮组之前截断，而不是盖到按钮上面。
const COMPACT_HEADER_SIDE_PADDING = 8
const COMPACT_HEADER_BUTTON_SIZE = 44
const COMPACT_HEADER_GAP = 6
const COMPACT_HEADER_TITLE_GAP = 8

/**
 * 计算紧凑模式下标题左右两侧应留出的安全距离。
 * controlCount 是当前这一侧的按钮数量，返回总占用宽度（像素）。
 */
function compactTitleInset(controlCount: number): number {
  if (controlCount <= 0) return 16
  return COMPACT_HEADER_SIDE_PADDING
    + (controlCount * COMPACT_HEADER_BUTTON_SIZE)
    + (controlCount * COMPACT_HEADER_GAP)
    + COMPACT_HEADER_TITLE_GAP
}

/** PanelHeaderProps：组件 props 类型定义 */
export interface PanelHeaderProps {
  /** 标题文字；传 undefined 时带动画隐藏 */
  title?: string
  /** 标题旁的徽章元素，例如 agent 徽章 */
  badge?: React.ReactNode
  /** 标题下拉菜单内容；传入后标题右侧会出现小箭头，点击展开菜单 */
  titleMenu?: React.ReactNode
  /**
   * 紧凑模式下的标题菜单替代节点。
   * 当传入该值且 isCompactMode === true 时，会用这个节点替换桌面端的 Radix DropdownMenu。
   * 调用方需要自行渲染触发按钮并保持标题样式一致。
   * 原因：在窄视口下 Radix 的浮层/嵌套子菜单会被面板容器裁剪，
   * 因此可以换成 vaul 的 Drawer。参考实现见 CompactSessionMenu。
   */
  compactTitleMenu?: React.ReactNode
  /** 标题左侧的操作节点，例如返回按钮 */
  leadingAction?: React.ReactNode
  /** 标题与右侧操作按钮之间的中间按钮 */
  centerButton?: React.ReactNode
  /** 右侧操作按钮组 */
  actions?: React.ReactNode
  /** 最右侧的侧边栏开关按钮 */
  rightSidebarButton?: React.ReactNode
  /** 为 true 时左侧边距动画避开 macOS 红绿灯（作为屏幕上第一个面板时使用） */
  compensateForStoplight?: boolean
  /** 左侧内边距覆盖值，例如聚焦模式配合红绿灯时使用 */
  paddingLeft?: string
  /** 额外的 CSS 类名 */
  className?: string
  /** 标题是否正在重新生成；为 true 时显示闪烁动画 */
  isRegeneratingTitle?: boolean
}

/**
 */
export function PanelHeader({
  title,
  badge,
  titleMenu,
  compactTitleMenu,
  leadingAction: explicitLeadingAction,
  centerButton,
  actions,
  rightSidebarButton,
  compensateForStoplight,
  paddingLeft,
  className,
  isRegeneratingTitle,
}: PanelHeaderProps) {
  // 如果调用方没传 leadingAction，就使用 AppShellContext 里的值。
  // 这样 PanelSlot 在紧凑模式下设置的返回按钮可以自动下沉到各页面标题栏，
  // 不需要每个页面手动透传。ChatPage 会显式传入自己的值并覆盖上下文。
  const { leadingAction: contextLeadingAction, isCompactMode } = useAppShellContext()
  const leadingAction = explicitLeadingAction ?? contextLeadingAction

  // 没有显式设置时回退到上下文。
  // 如果已经有返回按钮，就不需要再为红绿灯让位——返回按钮已经占用了那个区域。
  const contextCompensate = useCompensateForStoplight()
  const shouldCompensate = leadingAction ? false : (compensateForStoplight ?? contextCompensate)

  // 下拉菜单的受控状态：展开时点击整个标题都能触发，但锚点定位在 Chevron 上
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // 切换到紧凑模式时强制关闭桌面端下拉菜单，
  // 否则 unmount 后 open 状态会保留，等用户回到桌面宽度时菜单会错误地重新弹出。
  React.useEffect(() => {
    if (isCompactMode && dropdownOpen) setDropdownOpen(false)
  }, [isCompactMode, dropdownOpen])

  // 标题内容：静态标题或带下拉的标题。标题重新生成时显示闪烁效果。
  const titleContent = (
    <motion.div
      initial={false}
      animate={{ opacity: title ? 1 : 0 }}
      transition={{ duration: 0.15 }}
      className="flex items-center gap-1"
    >
      <h1 className={cn(
        "text-sm font-semibold truncate font-sans leading-tight",
        isRegeneratingTitle && "animate-shimmer-text"
      )}>{title}</h1>
      {badge}
    </motion.div>
  )

  // 标题节点：提供 titleMenu 时包装成可下拉的触发器，否则直接展示标题。
  // 桌面端和紧凑端共用这里的节点；紧凑模式下如果传了 compactTitleMenu，
  // 会用它替换桌面端的 DropdownMenu，避免 Radix 浮层被容器裁剪。
  const desktopTitleNode = titleMenu ? (
    <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
      {/* 整个可点击区域的外层按钮 */}
      <button
        onClick={() => setDropdownOpen(true)}
        className={cn(
          "flex items-center gap-1 px-2 py-1 rounded-md titlebar-no-drag min-w-0",
          "hover:bg-foreground/[0.03] transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          dropdownOpen && "bg-foreground/[0.03]"
        )}
      >
        {titleContent}
        {/* Chevron 小箭头才是真正的下拉触发锚点 */}
        <DropdownMenuTrigger asChild>
          <span className="shrink-0 flex items-center justify-center">
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground translate-y-[1px]" />
          </span>
        </DropdownMenuTrigger>
      </button>
      <StyledDropdownMenuContent align="center" sideOffset={8}>
        {titleMenu}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  ) : titleContent

  const titleNode = (isCompactMode && compactTitleMenu) ? compactTitleMenu : desktopTitleNode

  // 紧凑布局把标题放在绝对定位的覆盖层里居中显示。
  // 左右 inset 根据实际按钮数量计算，确保长标题先截断、不会压到右侧按钮组。
  const compactLeadingControlCount = leadingAction ? 1 : 0
  const compactTrailingControlCount = [centerButton, actions, rightSidebarButton].filter(Boolean).length
  const compactTitleInsetStyle = isCompactMode
    ? {
        left: compactTitleInset(compactLeadingControlCount),
        right: compactTitleInset(compactTrailingControlCount),
      }
    : undefined

  const content = isCompactMode ? (
    <>
      {leadingAction && (
        <div className="titlebar-no-drag shrink-0 z-[1]">
          {leadingAction}
        </div>
      )}
      <div className="flex-1" />
      {centerButton && (
        <div className="titlebar-no-drag shrink-0 z-[1]">
          {centerButton}
        </div>
      )}
      {actions && (
        <div className="titlebar-no-drag shrink-0 z-[1]">
          {actions}
        </div>
      )}
      {rightSidebarButton && (
        <div className="titlebar-no-drag shrink-0 z-[1]">
          {rightSidebarButton}
        </div>
      )}
      <div
        className="absolute inset-y-0 flex items-center justify-center pointer-events-none"
        style={compactTitleInsetStyle}
      >
        <div className="max-w-full overflow-hidden pointer-events-auto">
          {titleNode}
        </div>
      </div>
    </>
  ) : (
    <>
      {leadingAction && (
        <div className="titlebar-no-drag shrink-0">
          {leadingAction}
        </div>
      )}
      <div className="flex-1 min-w-0 flex items-center select-none">
        <div className={cn("max-w-full overflow-hidden", !leadingAction && "mx-auto")}>
          {titleNode}
        </div>
      </div>
      {centerButton && (
        <div className="titlebar-no-drag shrink-0">
          {centerButton}
        </div>
      )}
      {actions && (
        <div className="titlebar-no-drag shrink-0">
          {actions}
        </div>
      )}
      {rightSidebarButton && (
        <div className="titlebar-no-drag shrink-0">
          {rightSidebarButton}
        </div>
      )}
    </>
  )

  // 基础左侧内边距：有返回按钮时 8px，否则 16px，和右侧 pr-2 保持视觉对称
  const basePadding = leadingAction ? 8 : 16

  const baseClassName = cn(
    'flex shrink-0 items-center pr-2 min-w-0 gap-1.5 relative z-panel h-[42px]',
    // 只有不需要动画补偿时才使用静态 paddingLeft 类
    !shouldCompensate && (paddingLeft || (leadingAction ? 'pl-2' : 'pl-4')),
    className
  )

  // 用 motion.div 动画改变 paddingLeft，让内容整体右移，同时背景保持通栏
  return (
    <motion.div
      initial={false}
      animate={{ paddingLeft: shouldCompensate ? STOPLIGHT_PADDING : basePadding }}
      transition={springTransition}
      className={baseClassName}
    >
      {content}
    </motion.div>
  )
}
