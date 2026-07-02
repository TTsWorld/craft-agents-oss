import * as React from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/** 移动端菜单的页面壳组件。 */

export interface MobileMenuPageProps {
  title: string
  /**
   * 为 true 时，顶部左侧显示返回箭头并调用 onBack；
   * 为 false 时，不显示左侧控制按钮（根页面）。
   */
  showBack?: boolean
  onBack?: () => void
  /** 右上角关闭按钮，始终显示。 */
  onClose: () => void
  children: React.ReactNode
  className?: string
}

/**
 * 移动端菜单的通用全屏页面壳。
 *
 * 布局：顶部固定标题栏（返回/标题/关闭）+ 下方可滚动内容区。
 * padding 使用 env(safe-area-inset-*) 适配 iPhone 刘海屏。
 */
export function MobileMenuPage({
  title,
  showBack,
  onBack,
  onClose,
  children,
  className,
}: MobileMenuPageProps) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col bg-background',
        className,
      )}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <header className="shrink-0 h-12 border-b border-border flex items-center px-2">
        <div className="w-10 shrink-0">
          {showBack && onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('common.back')}
              className="h-10 w-10 flex items-center justify-center rounded-full active:bg-foreground/10"
            >
              <Icons.ChevronLeft className="h-5 w-5 text-foreground/80" strokeWidth={1.75} />
            </button>
          )}
        </div>
        <h2 className="flex-1 text-center text-[15px] font-medium text-foreground truncate px-2">
          {title}
        </h2>
        <div className="w-10 shrink-0 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="h-10 w-10 flex items-center justify-center rounded-full active:bg-foreground/10"
          >
            <Icons.X className="h-5 w-5 text-foreground/80" strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {children}
      </div>
    </div>
  )
}
