/**
 * AvatarGroup — 头像组。
 *
 * 最多显示 `max` 个头像，轻微重叠；超出时显示 "+N" 徽标。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

interface AvatarGroupProps {
  children: React.ReactNode
  /** 最多显示几个头像，超出显示 "+N" */
  max?: number
  className?: string
}

/** 头像组组件 */
export function AvatarGroup({ children, max = 3, className }: AvatarGroupProps) {
  const childArray = React.Children.toArray(children)
  const shown = childArray.slice(0, max)
  const overflow = childArray.length - max

  return (
    <div className={cn("flex -space-x-1.5", className)}>
      {shown.map((child, i) => (
        <div key={i} className="ring-1 ring-background rounded-full">
          {child}
        </div>
      ))}
      {overflow > 0 && (
        <div className="flex items-center justify-center h-4 w-4 rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-1 ring-background">
          +{overflow}
        </div>
      )}
    </div>
  )
}
