/**
 * MobileWebUIFrame — React 组件
 * MobileWebUIFrame：把子内容限制在一个手机形状视口内的 playground 组件。
 * 
 * 所属目录：mobile-webui
 * 本目录下的 demo 用于在桌面 Electron 中模拟移动端 WebUI 的渲染效果。
 */
import * as React from 'react'
// cn 是 tailwind-merge + clsx 的封装，用来条件组合 Tailwind 类名。
import { cn } from '@/lib/utils'

/** MobileDevice：类型别名 */
// 字面量联合类型，列出支持的手机型号；'custom' 允许自定义尺寸。
export type MobileDevice = 'iphone-15' | 'iphone-se' | 'pixel-8' | 'custom'

/** MobileWebUIFrameProps：组件 props 类型定义 */
export interface MobileWebUIFrameProps {
  /** Preset phone width × height. iPhone 15 is the default. */
  device?: MobileDevice
  /** Override width/height when device='custom'. */
  width?: number
  height?: number
  /** Adds a thin bezel + status-bar strip for visual context. */
  showBezel?: boolean
  className?: string
  // React.ReactNode 是 React 中最通用的子元素类型，可以是 JSX、字符串、数字、数组等。
  children: React.ReactNode
}

// Exclude<T, U> 从 MobileDevice 中排除 'custom'；Record<K, V> 构造键值对象类型。
const DEVICE_SIZES: Record<Exclude<MobileDevice, 'custom'>, { width: number; height: number; label: string }> = {
  'iphone-15': { width: 390, height: 844, label: 'iPhone 15' },
  'iphone-se': { width: 375, height: 667, label: 'iPhone SE' },
  'pixel-8': { width: 412, height: 915, label: 'Pixel 8' },
}

/**
 * Constrains its child to a phone-shaped viewport. Default 390×844 (iPhone 15).
 *
 * The inner content div names the `shell` and `panel` containers used by
 * AppShell / PanelSlot, so internal compact-mode container queries fire
 * naturally when their layout reads `@container/shell` or `@container/panel`.
 * 内层 div 同时声明了 @container/shell 和 @container/panel 容器查询名称，
 * 让 AppShell / PanelSlot 内部的响应式布局在桌面端也能按移动端尺寸触发。
 */
export function MobileWebUIFrame({
  device = 'iphone-15',
  width,
  height,
  showBezel = true,
  className,
  children,
}: MobileWebUIFrameProps) {
  // ?? 是空值合并运算符：仅当左侧为 null/undefined 时取右侧默认值。
  const size = device === 'custom'
    ? { width: width ?? 390, height: height ?? 844, label: `${width ?? 390}×${height ?? 844}` }
    : DEVICE_SIZES[device]

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      {/* 外层手机框；cn 根据 showBezel 切换圆角/边框样式。 */}
      <div
        className={cn(
          'relative bg-background overflow-hidden flex flex-col',
          showBezel
            ? 'rounded-[36px] border-[10px] border-foreground/80 shadow-2xl'
            : 'rounded-lg border border-border',
        )}
        style={{ width: size.width, height: size.height }}
      >
        {showBezel && (
          <div className="h-7 shrink-0 flex items-center justify-center bg-foreground/95 text-background text-[11px] font-medium tabular-nums">
            <span>9:41</span>
          </div>
        )}
        <div
          data-mobile-menu-root="true"
          className="@container/shell @container/panel relative flex-1 min-h-0 overflow-hidden bg-background"
        >
          {children}
        </div>
      </div>
      <span className="text-[11px] font-mono text-muted-foreground">
        {size.label} — {size.width}×{size.height}
      </span>
    </div>
  )
}
