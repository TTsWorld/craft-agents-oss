import * as React from 'react'
import * as Icons from 'lucide-react'
import { cn } from '@/lib/utils'

/** 移动端菜单每一行组件。 */

export type MobileMenuItemAffordance = 'chevron' | 'external' | 'none'

export interface MobileMenuItemProps {
  /** Lucide 图标组件，或传入自定义节点；不传则不显示图标。 */
  icon?: React.ReactNode
  label: string
  /**
   * 右侧尾部提示图标。
   * - chevron  → 进入子页面
   * - external → 打开外部链接
   * - none     → 原地触发回调
   */
  affordance?: MobileMenuItemAffordance
  /** 标签下方可选的说明文字。 */
  description?: string
  onClick: () => void
  destructive?: boolean
  className?: string
}

/**
 * 适合触摸的菜单行。
 *
 * - 最小点击区域 44px，符合 iOS HIG；
 * - 整行可点；
 * - 使用 active 状态（半透明背景），不设置 hover（触摸设备没有 hover）。
 */
export function MobileMenuItem({
  icon,
  label,
  affordance = 'none',
  description,
  onClick,
  destructive,
  className,
}: MobileMenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 px-4 min-h-[44px] py-2.5 text-left',
        'active:bg-foreground/10 transition-colors',
        destructive ? 'text-destructive' : 'text-foreground',
        className,
      )}
    >
      {icon && (
        <span className={cn(
          'shrink-0 flex items-center justify-center',
          destructive ? 'text-destructive' : 'text-foreground/70',
        )}>
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-base leading-tight">{label}</span>
        {description && (
          <span className="block text-[13px] text-foreground/50 truncate mt-0.5">
            {description}
          </span>
        )}
      </span>
      {affordance === 'chevron' && (
        <Icons.ChevronRight className="h-4 w-4 shrink-0 text-foreground/40" strokeWidth={1.75} />
      )}
      {affordance === 'external' && (
        <Icons.ExternalLink className="h-4 w-4 shrink-0 text-foreground/40" strokeWidth={1.75} />
      )}
    </button>
  )
}
