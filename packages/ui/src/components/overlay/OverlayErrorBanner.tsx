/**
 * OverlayErrorBanner - 预览浮层的共享错误横幅
 *
 * 样式匹配 TurnCard 的着色阴影模式：
 * - 5% destructive color-mixed 背景
 * - shadow-tinted 配合 --shadow-color: var(--destructive-rgb)
 * - 居中对齐，最大宽度与 ContentFrame 卡片一致（850px）
 *
 * 在每个浮层中渲染在内容容器之上。
 */

import type React from 'react'

export interface OverlayErrorBannerProps {
  /** 描述错误类型的简短标签（如"Write Failed"、"Read Failed"） */
  label: string
  /** 完整错误消息 */
  message: string
}

export function OverlayErrorBanner({ label, message }: OverlayErrorBannerProps) {
  return (
    <div className="w-full max-w-[850px] mx-auto">
      <div
        className="px-4 py-3 rounded-[8px] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted"
        style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
      >
        <div className="text-xs font-semibold text-destructive/70 mb-0.5">{label}</div>
        <p className="text-sm text-destructive whitespace-pre-wrap break-words font-mono">{message}</p>
      </div>
    </div>
  )
}
