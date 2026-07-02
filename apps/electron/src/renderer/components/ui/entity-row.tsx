/**
 * EntityRow — 列表项的通用视觉骨架。
 *
 * 从 SessionItem / SourceItem / SkillItem 抽象出来，它们共享相同布局：
 * - 左侧图标
 * - 标题 + 徽标/副标题行
 * - 可选的尾部内容（时间戳、数量）
 * - hover 时显示的 MoreHorizontal 下拉菜单 + 右键菜单
 * - 选中/多选样式
 * - 可选的顶部分隔线
 * - 按钮下方可渲染子内容（如展开的子列表）
 * - 可选的绝对定位覆盖层（如匹配数徽标）
 *
 * 业务逻辑（图标、徽标、菜单项）通过插槽注入，保持组件通用。
 */

import * as React from 'react'
import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
} from '@/components/ui/styled-dropdown'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import { DropdownMenuProvider, ContextMenuProvider } from '@/components/ui/menu-context'
import {
  LONG_PRESS_MS,
  MOVE_TOLERANCE_PX,
  shouldFireLongPress,
} from '@/components/ui/long-press-state'
import { cn } from '@/lib/utils'

/**
 * 抽屉打开后，需要短暂忽略下一次激活事件（onMouseDown / onClick）。
 * 这样用户松开长按/右键时，不会同时触发列表项选中。
 * 普通点击 < 300ms，不会被误吞。
 */
const SUPPRESS_ACTIVATION_MS = 300

/** EntityRow 的 props。 */
export interface EntityRowProps {
  /** 左侧图标区域，可传入多个图标（如用 Fragment 包裹） */
  icon?: React.ReactNode
  /** 标题内容（用 ReactNode 支持搜索高亮） */
  title: React.ReactNode
  /** 标题包装器的额外 className（如闪光动画） */
  titleClassName?: string
  /** 标题右侧内联内容（如时间戳）。hover 时会被更多按钮替换。
   *  设置后标题行变成单行截断，且绝对定位的更多按钮隐藏。 */
  titleTrailing?: React.ReactNode
  /** 标题后紧跟的内联内容，位于标题与 trailing 之间。
   *  用于小尺寸、高优先级的内联标签（如平台绑定），应视为标题区域的一部分。 */
  titleSuffix?: React.ReactNode
  /** 标题下方的可选副标题行 */
  subtitle?: React.ReactNode
  /** 标题下方的徽标/元数据行 */
  badges?: React.ReactNode
  /** 徽标行右侧内容（时间戳、子项切换等） */
  trailing?: React.ReactNode
  /** 主按钮下方渲染的内容（如展开的子列表） */
  children?: React.ReactNode
  /** 绝对定位覆盖层（如匹配数徽标） */
  overlay?: React.ReactNode

  // --- 交互 ---
  /** 是否选中 */
  isSelected?: boolean
  /** 是否处于多选高亮（左侧强调条 + 背景色） */
  isInMultiSelect?: boolean
  /** 抑制左边缘选中条（背景色调仍会显示）。当外层包裹器在同一个前导边缘
   *  自行绘制强调条（如项目颜色）时使用，避免两者重叠冲突。 */
  suppressSelectionBar?: boolean
  /** 点击处理 —— Session 用 onMouseDown 检测修饰键，简单场景用 onClick */
  onMouseDown?: (e: React.MouseEvent) => void
  /** 简单点击回调 */
  onClick?: () => void
  /** 在该行上方显示分隔线 */
  showSeparator?: boolean

  // --- 菜单 ---
  /** 菜单内容，会同时渲染在下拉菜单和右键菜单中。
   *  应使用 useMenuComponents() 的组件作为内容。 */
  menuContent?: React.ReactNode
  /** 与下拉菜单不同的右键菜单内容（如多选时的批量菜单） */
  contextMenuContent?: React.ReactNode
  /** 是否隐藏更多按钮（如覆盖层显示时） */
  hideMoreButton?: boolean
  /** 是否以紧凑（抽屉）模式渲染菜单。由调用方透传，保持 EntityRow 通用。 */
  isCompactMode?: boolean
  /** 紧凑菜单的 render-prop。EntityRow 自己维护打开状态（由“…”按钮、长按、右键共同触发），
   *  并把状态交给调用方，使两个触发器共用一个抽屉实例。
   *  未传入或 isCompactMode=false 时，使用原有下拉/右键菜单行为。 */
  compactMenu?: (props: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => React.ReactNode

  // --- 透传 ---
  /** 额外属性透传到 <button>（aria、键盘处理、tabIndex、ref 等） */
  buttonProps?: Record<string, unknown>
  /** 外层 wrapper div 的 data 属性 */
  dataAttributes?: Record<string, string | undefined>
  /** 外层 wrapper className */
  className?: string
  /** 分隔线内边距类（默认 'pl-12 pr-4'） */
  separatorClassName?: string
}

/** 实体列表行 */
export function EntityRow({
  icon,
  title,
  titleClassName,
  titleTrailing,
  titleSuffix,
  subtitle,
  badges,
  trailing,
  children,
  overlay,
  isSelected = false,
  isInMultiSelect = false,
  suppressSelectionBar = false,
  onMouseDown,
  onClick,
  showSeparator = false,
  menuContent,
  contextMenuContent,
  hideMoreButton = false,
  isCompactMode = false,
  compactMenu,
  buttonProps,
  dataAttributes,
  className,
  separatorClassName = 'pl-12 pr-4',
}: EntityRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [compactMenuOpen, setCompactMenuOpen] = useState(false)

  // 紧凑菜单只在同时传入 isCompactMode 和 compactMenu 时才生效。
  // 桌面端调用点不传 compactMenu 时保持原有 Radix 下拉/右键菜单行为。
  const useCompactMenu = isCompactMode && !!compactMenu

  // 长按 + 抑制状态。使用 ref 而不是 React state，因为指针事件处理函数
  // 在 React 提交周期外运行；用 state 会在每次移动时触发重渲染。
  const pointerDownRef = React.useRef<{
    x: number
    y: number
    timer: number
  } | null>(null)
  const suppressNextActivationRef = React.useRef(false)

  const cancelLongPress = React.useCallback(() => {
    if (pointerDownRef.current) {
      window.clearTimeout(pointerDownRef.current.timer)
      pointerDownRef.current = null
    }
  }, [])

  // 卸载时清理_pending_长按定时器，否则行在按压中途卸载后，
  // 回调可能在 React 树已销毁后才触发。
  React.useEffect(() => {
    return () => {
      if (pointerDownRef.current) {
        window.clearTimeout(pointerDownRef.current.timer)
        pointerDownRef.current = null
      }
    }
  }, [])

  const armSuppression = React.useCallback(() => {
    suppressNextActivationRef.current = true
    window.setTimeout(() => {
      suppressNextActivationRef.current = false
    }, SUPPRESS_ACTIVATION_MS)
  }, [])

  const openCompactMenuFromGesture = React.useCallback(() => {
    setCompactMenuOpen(true)
    armSuppression()
  }, [armSuppression])

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      // 鼠标走原生右键菜单路径（onContextMenu）；只有触控/手写笔需要长按兜底。
      if (e.pointerType === 'mouse') return
      const start = { x: e.clientX, y: e.clientY }
      const timer = window.setTimeout(() => {
        openCompactMenuFromGesture()
        pointerDownRef.current = null
      }, LONG_PRESS_MS)
      pointerDownRef.current = { ...start, timer }
    },
    [openCompactMenuFromGesture],
  )

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      const state = pointerDownRef.current
      if (!state) return
      const decision = shouldFireLongPress(
        { x: state.x, y: state.y },
        { x: e.clientX, y: e.clientY },
        0, // 移动取消路径不需要经过时间
        LONG_PRESS_MS,
        MOVE_TOLERANCE_PX,
      )
      if (decision.cancel) cancelLongPress()
    },
    [cancelLongPress],
  )

  const onContextMenuCompact = React.useCallback(
    (e: React.MouseEvent) => {
      // 紧凑模式下的桌面右键：改为打开抽屉，而不是原生右键菜单
      // （紧凑分支没有渲染 Radix ContextMenu）。
      e.preventDefault()
      openCompactMenuFromGesture()
    },
    [openCompactMenuFromGesture],
  )

  // 包装调用方的事件处理：如果刚通过长按/右键打开抽屉，
  // pointer 释放时不要同时触发列表项选中。
  const wrappedOnMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      if (suppressNextActivationRef.current) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      onMouseDown?.(e)
    },
    [onMouseDown],
  )

  const wrappedOnClick = React.useCallback(() => {
    if (suppressNextActivationRef.current) return
    onClick?.()
  }, [onClick])

  // 紧凑模式不渲染 Radix ContextMenu，因此不需要覆盖内容——
  // 批量菜单/右键由抽屉处理。桌面模式使用原有 fallback。
  const resolvedContextMenu = useCompactMenu
    ? null
    : contextMenuContent ?? menuContent

  // 构建行内内容（有/无右键菜单时共享）
  const innerContent = (
    <div className="relative group select-none pl-2 mr-2">
      {/* 选中指示条 —— 当外层包裹器自行绘制前导条纹（如项目颜色）时抑制显示，
          避免两者堆叠。内部按钮上的背景色调仍会指示选中态。 */}
      {(isSelected || isInMultiSelect) && !suppressSelectionBar && (
        <div className="absolute left-0 inset-y-0 w-[2px] bg-accent" />
      )}

      {/* 主内容按钮 */}
      <button
        {...(buttonProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        className={cn(
          "entity-row-btn flex w-full items-start gap-2 pl-2 pr-4 py-3 text-left text-sm outline-none rounded-[8px]",
          "transition-[background-color] duration-75",
          (isSelected || isInMultiSelect)
            ? "bg-foreground/3"
            : "hover:bg-foreground/2",
          (buttonProps as Record<string, unknown>)?.className as string | undefined,
        )}
        onMouseDown={wrappedOnMouseDown}
        onClick={!onMouseDown ? wrappedOnClick : undefined}
        onPointerDown={useCompactMenu ? onPointerDown : undefined}
        onPointerMove={useCompactMenu ? onPointerMove : undefined}
        onPointerUp={useCompactMenu ? cancelLongPress : undefined}
        onPointerCancel={useCompactMenu ? cancelLongPress : undefined}
        onPointerLeave={useCompactMenu ? cancelLongPress : undefined}
        onContextMenu={useCompactMenu ? onContextMenuCompact : undefined}
      >
        {/* 内容列 */}
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          {/* 标题 */}
          {titleTrailing ? (
            <div className="flex items-center gap-[10px] w-full min-w-0">
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3">
                  {icon}
                </div>
              )}
              <div className={cn("font-sans truncate min-w-0", titleClassName)}>
                {title}
              </div>
              {titleSuffix && <div className="shrink-0 flex items-center">{titleSuffix}</div>}
              <div className="shrink-0 ml-auto relative -mr-1">
                <span className={cn(
                  menuOpen || contextMenuOpen || compactMenuOpen
                    ? "invisible"
                    : useCompactMenu ? undefined : "group-hover:invisible",
                )}>
                  {titleTrailing}
                </span>
                {(menuContent || useCompactMenu) && !hideMoreButton && (
                  <div
                    data-touch-reveal="true"
                    className={cn(
                      "absolute inset-0 flex items-center justify-end overflow-visible",
                      menuOpen || contextMenuOpen || compactMenuOpen
                        ? "opacity-100"
                        : useCompactMenu
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                    )}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {useCompactMenu ? (
                      <button
                        type="button"
                        onClick={() => setCompactMenuOpen(true)}
                        className="p-1 rounded-[6px] hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer"
                        aria-haspopup="dialog"
                        aria-expanded={compactMenuOpen}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5 text-foreground/40" />
                      </button>
                    ) : (
                      <DropdownMenu modal={true} open={menuOpen} onOpenChange={setMenuOpen}>
                        <DropdownMenuTrigger asChild>
                          <div className="p-1 rounded-[6px] hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer">
                            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                        </DropdownMenuTrigger>
                        <StyledDropdownMenuContent align="end">
                          <DropdownMenuProvider>
                            {menuContent}
                          </DropdownMenuProvider>
                        </StyledDropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-[10px] w-full pr-6 min-w-0">
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3">
                  {icon}
                </div>
              )}
              <div className={cn("font-medium font-sans line-clamp-2 min-w-0 -mb-[2px]", titleClassName)}>
                {title}
              </div>
              {titleSuffix && <div className="shrink-0 self-center flex items-center">{titleSuffix}</div>}
            </div>
          )}

          {/* 副标题行 */}
          {subtitle && (
            <div className="flex items-start gap-[10px] w-full text-[12px] text-foreground/55 min-w-0 -mt-1">
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3 invisible" aria-hidden="true">
                  {icon}
                </div>
              )}
              <div className="min-w-0 flex-1 line-clamp-2 leading-[1.35]">
                {subtitle}
              </div>
            </div>
          )}

          {/* 徽标 / 元数据行 */}
          {(badges || trailing) && (
            <div className="flex items-center gap-[10px] text-xs text-foreground/70 w-full -mb-[2px] min-w-0">
              {/* 与图标容器等宽的隐形占位，保持各行对齐 */}
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3 invisible" aria-hidden="true">
                  {icon}
                </div>
              )}
              {badges && (
                <div
                  className="flex-1 flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide"
                  style={{
                    maskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)',
                    WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)',
                  }}
                >
                  {badges}
                </div>
              )}
              {trailing && (
                <div className="shrink-0 flex items-center gap-1 ml-auto">
                  {trailing}
                </div>
              )}
            </div>
          )}
        </div>
      </button>

      {/* 按钮下方内容 */}
      {children}

      {/* 覆盖层（如匹配数徽标） */}
      {overlay}

      {/* 更多菜单按钮：hover 或菜单打开时显示（titleTrailing 内联处理时不渲染） */}
      {(menuContent || useCompactMenu) && !hideMoreButton && !titleTrailing && (
        <div
          data-touch-reveal="true"
          className={cn(
            "absolute right-2 top-2 transition-opacity z-10",
            menuOpen || contextMenuOpen || compactMenuOpen
              ? "opacity-100"
              : useCompactMenu
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100",
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center rounded-[8px] overflow-hidden border border-transparent hover:border-border/50">
            {useCompactMenu ? (
              <button
                type="button"
                onClick={() => setCompactMenuOpen(true)}
                className="p-1.5 hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer"
                aria-haspopup="dialog"
                aria-expanded={compactMenuOpen}
              >
                <MoreHorizontal className="h-4 w-4 text-foreground/40" />
              </button>
            ) : (
              <DropdownMenu modal={true} open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <div className="p-1.5 hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer">
                    <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                  </div>
                </DropdownMenuTrigger>
                <StyledDropdownMenuContent align="end">
                  <DropdownMenuProvider>
                    {menuContent}
                  </DropdownMenuProvider>
                </StyledDropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}

      {/* 紧凑抽屉挂载点：render-prop 作为行的兄弟元素渲染，
       *  让抽屉 portal 能挂载到当前面板上方，避免被行自身的 overflow 裁剪。 */}
      {useCompactMenu && compactMenu?.({
        open: compactMenuOpen,
        onOpenChange: setCompactMenuOpen,
      })}
    </div>
  )

  return (
    <div
      className={className}
      data-selected={isSelected || undefined}
      {...dataAttributes}
    >
      {/* 分隔线 */}
      {showSeparator && (
        <div className={separatorClassName}>
          <Separator />
        </div>
      )}

      {/* 提供菜单内容时包裹右键菜单 */}
      {resolvedContextMenu ? (
        <ContextMenu modal={true} onOpenChange={setContextMenuOpen}>
          <ContextMenuTrigger asChild>
            {innerContent}
          </ContextMenuTrigger>
          <StyledContextMenuContent>
            <ContextMenuProvider>
              {resolvedContextMenu}
            </ContextMenuProvider>
          </StyledContextMenuContent>
        </ContextMenu>
      ) : (
        innerContent
      )}
    </div>
  )
}
