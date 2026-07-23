/**
 * ItemNavigator - 浮层项目共享的箭头 + 下拉导航。
 *
 * 渲染左右箭头，中间是可点击的标签。
 * 点击标签打开下拉菜单列出所有项目供直接选择。
 * 活动项目显示勾选图标。
 *
 * 使用 StyledDropdown 组件保持一致的浮层样式（毛玻璃、模糊、尺寸）。
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'
import { cn } from '../../lib/utils'

interface NavigatorItem {
  label?: string
}

export interface ItemNavigatorProps {
  items: NavigatorItem[]
  activeIndex: number
  onSelect: (index: number) => void
  /** 尺寸变体 — 'sm' 用于行内块，'md' 用于全屏浮层 */
  size?: 'sm' | 'md'
}

export function ItemNavigator({ items, activeIndex, onSelect, size = 'sm' }: ItemNavigatorProps) {
  const { t } = useTranslation()
  const goToPrev = useCallback(() => {
    onSelect(Math.max(0, activeIndex - 1))
  }, [onSelect, activeIndex])

  const goToNext = useCallback(() => {
    onSelect(Math.min(items.length - 1, activeIndex + 1))
  }, [onSelect, activeIndex, items.length])

  if (items.length <= 1) return null

  const activeItem = items[activeIndex]
  const displayLabel = activeItem?.label || `${activeIndex + 1} / ${items.length}`

  return (
    <div className="flex items-center gap-1 select-none">
      <button
        onClick={goToPrev}
        disabled={activeIndex === 0}
        className={cn(
          'bg-background shadow-minimal cursor-pointer',
          'text-foreground/50 hover:text-foreground transition-colors',
          'disabled:opacity-30 disabled:cursor-not-allowed',
          size === 'md' ? 'p-1.5 rounded-[8px]' : 'p-1 rounded-[6px]'
        )}
        title={t('overlay.previousItem')}
      >
        <ChevronLeft className={size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'flex items-center text-muted-foreground font-medium',
              'bg-background shadow-minimal cursor-pointer',
              'hover:opacity-80 transition-opacity',
              size === 'md' ? 'text-[13px] px-3 h-[28px] w-[144px] justify-center rounded-[8px]' : 'text-[12px] px-2.5 h-[22px] w-[112px] justify-center rounded-[6px]'
            )}
            title={t('overlay.selectItem')}
          >
            <span className="truncate max-w-[120px]">{displayLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="center" className="max-h-64 overflow-y-auto" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
          {items.map((item, idx) => (
            <StyledDropdownMenuItem
              key={idx}
              onSelect={() => onSelect(idx)}
            >
              <span className="flex-1 truncate">
                {item.label || `Item ${idx + 1}`}
              </span>
              {idx === activeIndex && <Check className="w-3.5 h-3.5 text-accent" />}
            </StyledDropdownMenuItem>
          ))}
        </StyledDropdownMenuContent>
      </DropdownMenu>

      <button
        onClick={goToNext}
        disabled={activeIndex === items.length - 1}
        className={cn(
          'bg-background shadow-minimal cursor-pointer',
          'text-foreground/50 hover:text-foreground transition-colors',
          'disabled:opacity-30 disabled:cursor-not-allowed',
          size === 'md' ? 'p-1.5 rounded-[8px]' : 'p-1 rounded-[6px]'
        )}
        title={t('overlay.nextItem')}
      >
        <ChevronRight className={size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      </button>
    </div>
  )
}
