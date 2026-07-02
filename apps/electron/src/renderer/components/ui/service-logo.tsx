/**
 * 服务 Logo 组件。
 * 用于展示 MCP 服务器或 API 的图标，基于 CrossfadeAvatar 实现从占位到 Logo 的平滑过渡。
 * Logo 使用 Google Favicon 地址，由浏览器自动缓存。
 */

import * as React from 'react'
import { CrossfadeAvatar } from '@/components/ui/avatar'

interface ServiceLogoProps {
  logo?: string | null  // 外部 Logo 图片地址（通常为 Google Favicon）
  name: string          // 服务名称，用于 alt 和无图时展示
  fallbackIcon: React.ReactNode // 无 Logo 时的占位图标
  className?: string    // 外层样式类
}

/** 服务 Logo 组件。 */
export function ServiceLogo({
  logo,
  name,
  fallbackIcon,
  className = "h-6 w-6 rounded-md ring-1 ring-border/30"
}: ServiceLogoProps) {
  return (
    <CrossfadeAvatar
      src={logo}
      alt={name}
      className={className}
      fallbackClassName="bg-muted"
      fallback={fallbackIcon}
    />
  )
}
