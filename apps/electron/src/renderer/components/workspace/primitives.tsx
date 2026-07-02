import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Spinner } from '@craft-agent/ui'

/* =============================================================================
   添加工作区基础组件

   这些共享组件为“添加工作区”多步骤流程提供一致的样式与交互：
   - 统一的视觉风格
   - 便于全局调整样式
   - 一致的间距与排版
============================================================================= */

// =============================================================================
// 容器
// =============================================================================

interface AddWorkspaceContainerProps {
  /** 子节点，React 会把 JSX 子元素作为这个字段传入 */
  children: React.ReactNode
  className?: string
}

/**
 * AddWorkspaceContainer - 创建工作区步骤的外层容器
 *
 * 提供：
 * - 固定最大宽度（28rem）
 * - 圆角背景
 * - 明显阴影以提升层级
 * - 统一内边距
 */
export function AddWorkspaceContainer({ children, className }: AddWorkspaceContainerProps) {
  return (
    <div className={cn(
      "flex w-full max-w-[28rem] flex-col items-center",
      "bg-background rounded-[20px] shadow-strong p-8",
      className
    )}>
      {children}
    </div>
  )
}

// =============================================================================
// 步骤标题
// =============================================================================

interface AddWorkspaceStepHeaderProps {
  /** 主标题文案 */
  title: string
  /** 标题下方的可选说明，类型为 ReactNode，可以是一段 JSX */
  description?: React.ReactNode
  className?: string
}

/**
 * AddWorkspaceStepHeader - 每个工作区步骤的标题与说明
 *
 * 始终居中对齐，保持紧凑间距，保证视觉一致性。
 */
export function AddWorkspaceStepHeader({
  title,
  description,
  className
}: AddWorkspaceStepHeaderProps) {
  return (
    <div className={cn("text-center", className)}>
      <h1 className="text-lg font-semibold tracking-tight">
        {title}
      </h1>
      {description && (
        <p className="mt-1 text-sm max-w-sm text-muted-foreground mx-auto">
          {description}
        </p>
      )}
    </div>
  )
}

// =============================================================================
// 按钮
// =============================================================================

/**
 * 主按钮 props
 *
 * Omit<ButtonProps, 'variant' | 'children'> 表示从通用 ButtonProps 里剔除 variant 和 children，
 * 再由本接口重新声明，以便限制变体并允许 children 可选。
 */
interface AddWorkspacePrimaryButtonProps extends Omit<ButtonProps, 'variant' | 'children'> {
  children?: React.ReactNode
  loading?: boolean
  loadingText?: string
}

/**
 * AddWorkspacePrimaryButton - 添加工作区流程的主操作按钮
 *
 * 用于“创建”、“打开”等主要动作，内置 loading 状态并显示 Spinner。
 * 默认文案为 "Continue"，可通过 children 覆盖。
 */
export function AddWorkspacePrimaryButton({
  children = 'Continue',
  loading,
  loadingText,
  className,
  disabled,
  ...props
}: AddWorkspacePrimaryButtonProps) {
  return (
    <Button
      className={cn("w-full", className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="mr-2" />
          {loadingText || children}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

/**
 * 次级按钮 props
 *
 * 继承 ButtonProps 但剔除 variant，内部固定使用 secondary 变体。
 */
interface AddWorkspaceSecondaryButtonProps extends Omit<ButtonProps, 'variant'> {
  children?: React.ReactNode
}

/**
 * AddWorkspaceSecondaryButton - 添加工作区流程的次级按钮
 *
 * 用于“浏览”等辅助操作，或表单内的内联操作。
 */
export function AddWorkspaceSecondaryButton({
  children,
  className,
  ...props
}: AddWorkspaceSecondaryButtonProps) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className={cn("bg-background shadow-minimal", className)}
      {...props}
    >
      {children}
    </Button>
  )
}
