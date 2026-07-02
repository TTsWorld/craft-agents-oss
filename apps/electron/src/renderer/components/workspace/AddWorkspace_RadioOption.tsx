import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface AddWorkspace_RadioOptionProps {
  /** radio 组名，同一组内多个选项应使用相同 name */
  name: string
  /** 当前是否被选中 */
  checked: boolean
  /** 选中状态变化时的回调 */
  onChange: () => void
  /** 是否禁用 */
  disabled?: boolean
  /** 选项标题 */
  title: string
  /** 选项副标题，支持字符串或 JSX */
  subtitle: string | ReactNode
  /** 右侧附加操作，例如“浏览”按钮 */
  action?: ReactNode
}

/**
 * AddWorkspace_RadioOption - 添加工作区流程的通用单选组件
 *
 * 使用场景：
 * - AddWorkspaceStep_OpenFolder：选择“浏览已有文件夹”或“在指定位置新建文件夹”
 * - AddWorkspaceStep_CreateNew：选择默认位置或自定义位置
 */
export function AddWorkspace_RadioOption({
  name,
  checked,
  onChange,
  disabled = false,
  title,
  subtitle,
  action
}: AddWorkspace_RadioOptionProps) {
  return (
    <label className={cn(
      "flex items-center gap-3 p-3 rounded-lg cursor-pointer",
      "bg-background shadow-minimal",
      "transition-all duration-150",
      checked
        ? "hover:bg-accent/5"
        : "hover:bg-foreground/5",
      disabled && "opacity-50 cursor-not-allowed"
    )}>
      {/* 隐藏原生 radio，使用自定义圆圈样式 */}
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      <div className={cn(
        "h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0",
        checked
          ? "border-accent"
          : "border-foreground/30"
      )}>
        {checked && (
          <div className="h-2 w-2 rounded-full bg-accent" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground mt-[-1px]">
          {typeof subtitle === 'string' ? (
            <div className="truncate">{subtitle}</div>
          ) : (
            subtitle
          )}
        </div>
      </div>
      {action}
    </label>
  )
}
