/**
 * BrowserTabBadge
 *
 * 顶部浏览器标签条里使用的紧凑徽章组件。
 * 这是一个纯渲染组件，在 BrowserTabStrip 中作为下拉菜单的触发器。
 */

import { forwardRef, useEffect, useState, type ButtonHTMLAttributes } from 'react'
import * as Icons from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { getHostname, getThemeLuminance } from './utils'

// BrowserTabBadge 的 props 定义，继承自原生 <button> 的属性，方便复用 disabled/onClick 等。
interface BrowserTabBadgeProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  instance: BrowserInstanceInfo
  isActive: boolean
}

// forwardRef 让父组件可以把 ref 透传到内部的 <button>，类似 Go 里把对象引用往下传。
export const BrowserTabBadge = forwardRef<HTMLButtonElement, BrowserTabBadgeProps>(function BrowserTabBadge(
  { instance, isActive: _isActive, className, style, ...buttonProps },
  ref
) {
  // 从 URL 提取主机名作为兜底标题；如果标题为空，就显示域名或“Local File”。
  const hostname = getHostname(instance.url)
  const displayLabel = instance.title.trim() || hostname || 'Local File'
  // 页面自身提供的主题色，用作徽章背景。
  const themedBackground = instance.themeColor || undefined

  // 计算主题色的亮度，用于判断文字该用深色还是浅色，保证可读性。
  const themeLuminance = instance.themeColor ? getThemeLuminance(instance.themeColor) : null
  const isDarkThemeColor = themeLuminance !== null && themeLuminance < 0.42

  // 根据背景深浅选择前景色和悬停背景；没有主题色时采用默认主题色。
  const foregroundClass = instance.themeColor
    ? (isDarkThemeColor
      ? 'text-white/90 hover:bg-white/10'
      : 'text-black/80 hover:bg-black/5')
    : 'text-foreground hover:bg-foreground/[0.03]'

  // faviconFailed 记录图标是否加载失败；favicon 地址变化时重置状态。
  const [faviconFailed, setFaviconFailed] = useState(false)

  useEffect(() => {
    setFaviconFailed(false)
  }, [instance.favicon])

  return (
    <button
      ref={ref}
      type="button"
      className={`
        group flex items-center gap-1 h-[26px] pl-2.5 pr-1.5 rounded-lg cursor-pointer select-none titlebar-no-drag
        text-[11px] leading-tight transition-colors max-w-[160px] shadow-minimal
        bg-background
        ${foregroundClass}
        ${instance.agentControlActive ? 'border border-accent' : ''}
        ${className ?? ''}
      `}
      style={{
        backgroundColor: themedBackground,
        transition: 'background-color 200ms ease, border-color 200ms ease',
        ...style,
      }}
      aria-label={`${displayLabel} actions`}
      {...buttonProps}
    >
      {/* 左侧图标区域：加载中显示 Spinner，有 favicon 则显示 favicon，否则显示地球图标。 */}
      <span className={`shrink-0 flex items-center justify-center ${isDarkThemeColor ? 'h-3.5 w-3.5' : 'h-3 w-3'}`}>
        {instance.isLoading ? (
          <Spinner className="text-[9px] leading-none" />
        ) : instance.favicon && !faviconFailed ? (
          isDarkThemeColor ? (
            // 深色主题色背景下给图标加一层白色衬底，避免深色图标看不清。
            <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] bg-white/90 p-[1px] leading-none">
              <img
                src={instance.favicon}
                alt=""
                className="h-3 w-3 aspect-square rounded-none object-cover block"
                onError={() => setFaviconFailed(true)}
              />
            </span>
          ) : (
            <img
              src={instance.favicon}
              alt=""
              className="h-3 w-3 rounded-sm block"
              onError={() => setFaviconFailed(true)}
            />
          )
        ) : (
          <Icons.Globe className="h-3 w-3" />
        )}
      </span>

      {/* 中间标题，超出最大宽度时截断显示省略号。 */}
      <span className="truncate ml-0.5 leading-[12px]">{displayLabel}</span>

      {/* 右侧下拉箭头，hover 时提高不透明度。 */}
      <span className="shrink-0 h-3 w-3 flex items-center justify-center opacity-55 group-hover:opacity-90 transition-opacity">
        <Icons.ChevronDown className="h-2.5 w-2.5" />
      </span>
    </button>
  )
})

// 设置 displayName，方便 React DevTools 中查看组件名（匿名 forwardRef 组件会显示为 ForwardRef）。
BrowserTabBadge.displayName = 'BrowserTabBadge'
