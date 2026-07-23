import * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "../../lib/utils"

/**
 * 将时长格式化为易读形式
 * @param ms 时长（毫秒）
 * @returns 不足一分钟返回 "45s"，一分钟及以上返回 "1:02"
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export interface SpinnerProps {
  /** 附加 className */
  className?: string
}

/**
 * Spinner - 基于 SpinKit Grid 的 3x3 网格加载动画
 *
 * 特性：
 * - 使用 currentColor（继承父元素文本颜色）
 * - 使用 em 尺寸（随字号缩放）
 * - 3x3 立方体网格，带交错缩放动画
 * - 纯 CSS 动画（无 JS 状态）
 *
 * 用法：
 * ```tsx
 * // 继承父元素颜色与尺寸
 * <div className="text-muted-foreground text-sm">
 *   <Spinner />
 * </div>
 *
 * // 或通过 className 覆盖
 * <Spinner className="text-amber-500 text-lg" />
 * ```
 */
export function Spinner({ className }: SpinnerProps) {
  const { t } = useTranslation()
  return (
    <span
      className={cn("spinner", className)}
      role="status"
      aria-label={t("common.loading")}
    >
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
    </span>
  )
}

export interface LoadingIndicatorProps {
  /** 在 spinner 旁显示的可选标签 */
  label?: string
  /** 是否为 spinner 播放动画 */
  animated?: boolean
  /** 显示已用时长（传入起始时间戳，或传 true 自动追踪） */
  showElapsed?: boolean | number
  /** 容器的附加 className */
  className?: string
  /** spinner 的附加 className（例如 "text-xs" 使其更小） */
  spinnerClassName?: string
}

/**
 * LoadingIndicator - 带可选标签与已用时长的 Spinner
 *
 * 继承父元素的文本颜色与尺寸。
 *
 * 特性：
 * - 动画式 3x3 点阵 spinner（纯 CSS）
 * - 可选标签文本
 * - 可选已用时长展示
 */
export function LoadingIndicator({
  label,
  animated = true,
  showElapsed = false,
  className,
  spinnerClassName,
}: LoadingIndicatorProps) {
  const [elapsed, setElapsed] = React.useState(0)
  const startTimeRef = React.useRef<number | null>(null)

  // 已用时长追踪
  React.useEffect(() => {
    if (!showElapsed) return

    // 初始化起始时间
    if (typeof showElapsed === 'number') {
      startTimeRef.current = showElapsed
    } else if (!startTimeRef.current) {
      startTimeRef.current = Date.now()
    }

    const interval = setInterval(() => {
      if (startTimeRef.current) {
        setElapsed(Date.now() - startTimeRef.current)
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [showElapsed])

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {/* 加载动画 */}
      {animated ? (
        <Spinner className={spinnerClassName} />
      ) : (
        <span className="inline-flex items-center justify-center w-[1em] h-[1em]">●</span>
      )}

      {/* 标签 */}
      {label && (
        <span className="text-muted-foreground">
          {label}
        </span>
      )}

      {/* 已用时长 */}
      {showElapsed && elapsed >= 1000 && (
        <span className="text-muted-foreground/60 tabular-nums">
          ({formatDuration(elapsed)})
        </span>
      )}
    </span>
  )
}
