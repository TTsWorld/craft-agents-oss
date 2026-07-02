/**
 * FreeFormInputContextBadge - 自由输入区的上下文徽章。
 *
 * 用于 Sources、Files、Folder 等选择器，统一展示图标、标签和可选下拉箭头。
 * 支持展开、折叠（有/无选择）和打开三种视觉状态。
 */
import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { FadingText } from '@/components/ui/fading-text'
import { cn } from '@/lib/utils'

/** FreeFormInputContextBadgeProps：组件 props 类型定义 */
export interface FreeFormInputContextBadgeProps {
  /** 左侧区域，完全自定义（图标、头像堆叠等） */
  icon: React.ReactNode
  /** 标签文字：展开状态显示，或折叠且有选择时显示 */
  label: string
  /** 是否展开（图标 + 标签 + 箭头） */
  isExpanded?: boolean
  /** 是否有当前选择（影响折叠态样式并显示标签） */
  hasSelection?: boolean
  /** 是否显示下拉箭头（仅在展开态可见） */
  showChevron?: boolean
  /** 点击回调 */
  onClick?: () => void
  /** Tooltip 内容，可以是字符串或 ReactNode */
  tooltip?: React.ReactNode
  /** 徽章是否处于“打开”状态（如下拉菜单展开） */
  isOpen?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 按钮额外的 CSS 类名 */
  className?: string
  /** 用于定位下拉菜单的 ref */
  buttonRef?: React.RefObject<HTMLButtonElement>
  /** 教程用的 data 属性 */
  'data-tutorial'?: string
}

/**
 * FreeFormInputContextBadge - Sources、Files、Folder 选择器的统一上下文徽章。
 *
 * 视觉状态：
 * - 展开：图标 + 标签 + 箭头，无背景，悬停显示背景
 * - 折叠（无选择）：仅图标，无背景，悬停显示背景
 * - 折叠（有选择）：图标 + 标签（渐隐），bg-background + shadow-minimal
 * - 打开：bg-foreground/5（和悬停一致）
 */
export const FreeFormInputContextBadge = React.forwardRef<HTMLButtonElement, FreeFormInputContextBadgeProps>(
  function FreeFormInputContextBadge(
    {
      icon,
      label,
      isExpanded = false,
      hasSelection = false,
      showChevron = false,
      onClick,
      tooltip,
      isOpen = false,
      disabled = false,
      className,
      buttonRef,
      'data-tutorial': dataTutorial,
    },
    ref
  ) {
    // 如果同时传了 buttonRef 和 ref，优先使用 buttonRef
    const mergedRef = buttonRef || ref

    // 展开态始终显示标签；折叠态只有存在选择时才显示
    const showLabel = isExpanded || hasSelection

    const button = (
      <button
        ref={mergedRef as React.Ref<HTMLButtonElement>}
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        data-tutorial={dataTutorial}
        className={cn(
          // 基础样式：shrink + min-w-0 让徽章在拥挤布局中可压缩
          "input-toolbar-btn inline-flex items-center gap-1.5 h-7 rounded-[6px] text-[13px] text-foreground transition-colors select-none shrink min-w-0",
          "disabled:opacity-50 disabled:pointer-events-none",
          // 显示标签时内边距更大
          showLabel ? "px-2" : "px-1.5",
          // 折叠且有选择：可见背景 + 细边框 + 外边距
          !isExpanded && hasSelection && "bg-background border border-foreground/5 mx-0.5",
          // 悬停状态（未因选择显示背景时）
          !(!isExpanded && hasSelection) && "hover:bg-foreground/5",
          // 打开状态（下拉展开）
          isOpen && "bg-foreground/5",
          className
        )}
      >
        {/* 图标区域 */}
        <span className="shrink-0 flex items-center">
          {icon}
        </span>

        {/* 标签：展开态或折叠有选择时显示 */}
        {showLabel && (
          isExpanded ? (
            // 展开态：简单截断；占位（无选择）时透明度 60%
            <span className={cn("truncate max-w-[120px] min-w-0 shrink", !hasSelection && "opacity-50")}>
              {label}
            </span>
          ) : (
            // 折叠有选择：使用渐隐文本并限制最大宽度
            <FadingText className="max-w-[140px] min-w-0 shrink" fadeWidth={20}>
              {label}
            </FadingText>
          )
        )}

        {/* 可选下拉箭头：仅在展开态显示 */}
        {isExpanded && showChevron && (
          <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
        )}
      </button>
    )

    // 如果提供了 tooltip 且下拉未打开，则包一层 Tooltip（避免冲突）
    if (tooltip && !isOpen) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            {button}
          </TooltipTrigger>
          <TooltipContent side="top">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      )
    }

    return button
  }
)
