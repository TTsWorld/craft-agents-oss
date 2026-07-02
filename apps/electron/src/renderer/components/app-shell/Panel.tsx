/**
 * Panel - 应用面板的通用容器组件
 *
 * 作用：给所有面板提供一致的背景、溢出处理等外壳样式。
 * 注意：圆角和阴影由父容器（如 AppShell）统一处理，避免嵌套圆角产生的视觉瑕疵。
 *
 * 用法：
 * ```tsx
 * <Panel variant="grow">
 *   <PanelHeader title="标题" subtitle="副标题" />
 *   <Separator />
 *   {content}
 * </Panel>
 * ```
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

/** PanelProps：组件 props 类型定义 */
export interface PanelProps {
  /** 面板尺寸行为：grow（自适应）或 shrink（固定宽） */
  variant?: 'shrink' | 'grow'
  /** 固定宽度（像素），仅在 variant='shrink' 时生效 */
  width?: number
  /** 额外的 CSS 类名，用于覆盖或扩展样式 */
  className?: string
  /** 内联样式 */
  style?: React.CSSProperties
  /** 面板内部内容 */
  children: React.ReactNode
}

/**
 * 基础面板容器，统一处理尺寸与溢出样式。
 * - variant="grow"：自适应占满剩余空间（类似 CSS flex:1）。
 * - variant="shrink"：固定宽度，不伸缩。
 */
export function Panel({
  variant = 'grow',
  width,
  className,
  style,
  children,
}: PanelProps) {
  return (
    <div
      className={cn(
        // 所有面板共有的基础样式
        // 注意：这里不加圆角和背景色，由外层容器或调用方处理，避免嵌套裁剪问题
        'h-full flex flex-col min-w-0 overflow-hidden',
        // 根据 variant 追加的样式
        variant === 'grow' && 'flex-1',
        variant === 'shrink' && 'shrink-0',
        className
      )}
      style={{
        ...(variant === 'shrink' && width ? { width } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  )
}
