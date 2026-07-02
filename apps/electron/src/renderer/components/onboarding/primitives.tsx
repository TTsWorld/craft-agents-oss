import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Spinner } from "@craft-agent/ui"

/* =============================================================================
   ONBOARDING 基础组件（Primitives）

   这些组件负责统一所有引导步骤的样式，好处是：
   - 全局样式只改一处
   - 步骤组件只关心业务逻辑，不关心布局细节
   - 间距、字体、颜色保持一致
============================================================================= */

// =============================================================================
// 步骤图标
// =============================================================================

// 图标视觉变体
export type StepIconVariant = 'primary' | 'success' | 'error' | 'loading' | 'none'

// StepIcon 的 props 接口
interface StepIconProps {
  /** 要显示的图标（可以是 lucide-react 图标或 SVG） */
  children: React.ReactNode
  /** 视觉变体，影响图标颜色 */
  variant?: StepIconVariant
  className?: string
}

// 每种变体对应的样式
const iconVariantStyles: Record<StepIconVariant, { container: string; icon: string }> = {
  primary: {
    container: '',
    icon: 'text-foreground',
  },
  success: {
    container: '',
    icon: 'text-success',
  },
  error: {
    container: '',
    icon: 'text-destructive',
  },
  loading: {
    container: '',
    icon: 'text-foreground',
  },
  none: {
    container: '',
    icon: '',
  },
}

/**
 * StepIcon - 步骤顶部圆形图标容器
 *
 * 放在居中的步骤布局顶部，提供视觉上下文。
 */
export function StepIcon({ children, variant = 'primary', className }: StepIconProps) {
  const styles = iconVariantStyles[variant]

  return (
    <div
      className={cn(
        "step-icon",
        "mb-6 flex size-16 items-center justify-center",
        styles.container,
        className
      )}
    >
      <div className={cn("size-8 [&>svg]:size-full", styles.icon)}>
        {children}
      </div>
    </div>
  )
}

// =============================================================================
// 步骤标题
// =============================================================================

// StepHeader 的 props 接口
interface StepHeaderProps {
  /** 主标题 */
  title: string
  /** 标题下方的描述 */
  description?: React.ReactNode
  /** 是否居中，默认 true */
  centered?: boolean
  className?: string
}

/**
 * StepHeader - 步骤的标题和描述
 *
 * 同时支持居中布局（带图标）和表单布局。
 */
export function StepHeader({
  title,
  description,
  centered = true,
  className
}: StepHeaderProps) {
  return (
    <div className={cn(centered && "text-center", className)}>
      <h1 className="step-title text-lg font-semibold tracking-tight">
        {title}
      </h1>
      {description && (
        <p className="step-description mt-2 text-sm max-w-sm text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  )
}

// =============================================================================
// 步骤布局
// =============================================================================

// StepFormLayout 的 props 接口
interface StepFormLayoutProps {
  /** 顶部图标，会被 StepIcon 包裹（可选） */
  icon?: React.ReactNode
  /** 图标变体 */
  iconVariant?: StepIconVariant
  /** 不经过 StepIcon 包裹的原始图标元素（可选） */
  iconElement?: React.ReactNode
  /** 步骤标题 */
  title: string
  /** 步骤描述 */
  description?: React.ReactNode
  /** 底部操作按钮 */
  actions?: React.ReactNode
  /** 表单内容 */
  children?: React.ReactNode
  /** 子元素是否自动填充剩余空间（用于可滚动内容） */
  grow?: boolean
  /** 是否让布局占满父容器高度（不受 max-height 限制） */
  fillHeight?: boolean
  className?: string
}

/**
 * StepFormLayout - 所有引导步骤的统一样式布局
 *
 * 支持：
 * - 顶部可选图标（通过 icon 或 iconElement）
 * - 居中的标题和描述
 * - 下方全宽内容（表单、列表等）
 * - 底部操作按钮
 */
export function StepFormLayout({
  icon,
  iconVariant = 'primary',
  iconElement,
  title,
  description,
  actions,
  children,
  grow = false,
  fillHeight = false,
  className
}: StepFormLayoutProps) {
  return (
    <div className={cn(
      "flex w-full max-w-[28rem] flex-col items-center",
      grow && !fillHeight && "h-full max-h-[600px]",
      fillHeight && "h-full",
      className
    )}>
      {iconElement && (
        <div className="mb-6 shrink-0">
          {iconElement}
        </div>
      )}
      {icon && !iconElement && (
        <StepIcon variant={iconVariant}>
          {icon}
        </StepIcon>
      )}

      <div className="shrink-0">
        <StepHeader title={title} description={description} />
      </div>

      {children && (
        <div className={cn(
          "mt-6 w-full",
          (grow || fillHeight) && "flex-1 min-h-0"
        )}>
          {children}
        </div>
      )}

      {actions && (
        <StepActions variant="flex" className="mt-6 w-full shrink-0">
          {actions}
        </StepActions>
      )}
    </div>
  )
}

// =============================================================================
// 步骤操作按钮容器
// =============================================================================

// StepActions 的 props 接口
interface StepActionsProps {
  children: React.ReactNode
  /** 布局变体：'stack' 垂直排列，'flex' 水平均分 */
  variant?: 'stack' | 'flex'
  className?: string
}

/**
 * StepActions - 操作按钮容器
 *
 * - 'stack'：垂直堆叠，适合多个主要操作的居中布局
 * - 'flex'：水平排列，按钮均分，适合 返回/继续 模式
 */
export function StepActions({ children, variant = 'stack', className }: StepActionsProps) {
  return (
    <div
      className={cn(
        "step-actions mt-8",
        variant === 'stack' && "flex flex-col gap-3",
        variant === 'flex' && "flex gap-3 justify-center",
        className
      )}
    >
      {children}
    </div>
  )
}

// =============================================================================
// 按钮辅助组件
// =============================================================================

// BackButton 的 props 接口：继承 ButtonProps，但排除 variant 和 children
interface BackButtonProps extends Omit<ButtonProps, 'variant' | 'children'> {
  children?: React.ReactNode
}

/**
 * BackButton - 统一的返回 / 取消按钮
 */
export function BackButton({ children = 'Back', className, ...props }: BackButtonProps) {
  return (
    <Button variant="ghost" className={cn("flex-1 max-w-[320px] bg-foreground-2 shadow-minimal text-foreground hover:bg-foreground/5 rounded-lg", className)} {...props}>
      {children}
    </Button>
  )
}

// ContinueButton 的 props 接口：继承 ButtonProps，但排除 children
interface ContinueButtonProps extends Omit<ButtonProps, 'children'> {
  children?: React.ReactNode
  loading?: boolean
  loadingText?: string
}

/**
 * ContinueButton - 统一的主要操作按钮
 */
export function ContinueButton({
  children = 'Continue',
  loading,
  loadingText = 'Loading...',
  className,
  disabled,
  ...props
}: ContinueButtonProps) {
  return (
    <Button className={cn("flex-1 max-w-[320px] bg-background shadow-minimal text-foreground hover:bg-foreground/5 rounded-lg", className)} disabled={disabled || loading} {...props}>
      {loading ? (
        <>
          <Spinner className="mr-2" />
          {loadingText}
        </>
      ) : (
        children
      )}
    </Button>
  )
}
