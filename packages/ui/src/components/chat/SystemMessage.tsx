/**
 * SystemMessage - 展示 system/info/error/warning 消息
 *
 * 用于展示非对话类消息，例如错误、警告、提示通知以及一般系统消息。
 * 根据消息类型支持不同的视觉样式。
 *
 * error 和 warning 类型使用 shadow-tinted 以获得更柔和、精致的观感；
 * system 和 info 类型使用简单的带边框样式。
 */

import type { CSSProperties } from 'react'
import { cn } from '../../lib/utils'
import { Markdown } from '../markdown'

export type SystemMessageType = 'error' | 'info' | 'warning' | 'system'

export interface SystemMessageProps {
  /** 消息内容（支持 markdown） */
  content: string
  /** 决定视觉样式的消息类型 */
  type: SystemMessageType
  /** 外层容器的额外 className */
  className?: string
}

// 每种消息类型的样式配置
// error 和 warning 使用 shadow-tinted 配淡背景，其余使用带边框样式
const MESSAGE_STYLES: Record<SystemMessageType, {
  className: string
  useTintedShadow: boolean
  shadowColor?: string
  bgStyle?: CSSProperties
}> = {
  error: {
    // 使用 -text 变体（与前景色混合）以获得更好的文字对比度
    className: 'text-[var(--destructive-text)] shadow-tinted',
    useTintedShadow: true,
    shadowColor: 'var(--destructive-rgb)',
    bgStyle: { backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)' },
  },
  warning: {
    // 使用 -text 变体（与前景色混合）以获得更好的文字对比度
    className: 'text-[var(--info-text)] shadow-tinted',
    useTintedShadow: true,
    shadowColor: 'var(--info-rgb)',
    bgStyle: { backgroundColor: 'oklch(from var(--info) l c h / 0.03)' },
  },
  info: {
    className: 'text-muted-foreground border border-muted bg-muted/30',
    useTintedShadow: false,
  },
  system: {
    className: 'text-muted-foreground border border-muted bg-muted/30',
    useTintedShadow: false,
  },
}

/**
 * SystemMessage - 根据类型渲染带样式的消息气泡
 */
export function SystemMessage({
  content,
  type,
  className,
}: SystemMessageProps) {
  const style = MESSAGE_STYLES[type]

  return (
    <div className={cn("px-4 py-2", className)}>
      <div
        className={cn("text-sm px-3 py-2 rounded-md", style.className)}
        style={{
          ...style.bgStyle,
          ...(style.useTintedShadow && style.shadowColor
            ? { '--shadow-color': style.shadowColor } as CSSProperties
            : {}),
        }}
      >
        <Markdown mode="minimal">{content}</Markdown>
      </div>
    </div>
  )
}
