/**
 * Info_Page
 *
 * 信息页的复合布局组件，统一处理加载中、错误、空数据三种状态。
 * 由 Root / Header / Hero / Content 四个子组件组合而成，类似 React 中的「复合组件」模式。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { PanelHeader, type PanelHeaderProps } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'

export interface Info_PageProps {
  children: React.ReactNode
  /** 是否显示加载中 spinner */
  loading?: boolean
  /** 错误状态提示文本 */
  error?: string
  /** 空状态提示文本 */
  empty?: string
  className?: string
}

export interface Info_PageHeaderProps extends Omit<PanelHeaderProps, 'className'> {
  className?: string
}

export interface Info_PageHeroProps {
  /** 头像 / 图标元素 */
  avatar: React.ReactNode
  /** 标题，显示在头像右侧 */
  title?: string
  /** 副标题 / 描述，显示在标题下方 */
  tagline?: string | null
  className?: string
}

export interface Info_PageContentProps {
  children: React.ReactNode
  className?: string
}

function Info_PageRoot({
  children,
  loading,
  error,
  empty,
  className,
}: Info_PageProps) {
  const { t } = useTranslation()
  // 从子元素中拆分出 Header，确保加载 / 错误 / 空状态时也能保持一致的页面结构
  let header: React.ReactNode = null
  const otherChildren: React.ReactNode[] = []

  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === Info_PageHeader) {
      header = child
    } else {
      otherChildren.push(child)
    }
  })

  // 加载中状态：保留 header，内容区显示 spinner
  if (loading) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        {header}
        <div className="flex-1 flex items-center justify-center">
          <Spinner className="text-lg text-muted-foreground" />
        </div>
      </div>
    )
  }

  // 错误状态：保留 header，内容区显示错误图标与提示
  if (error) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground p-4">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <p className="text-sm font-medium">{t('common.errorLoadingContent')}</p>
          <p className="text-xs text-center max-w-md">{error}</p>
        </div>
      </div>
    )
  }

  // 空状态：保留 header，内容区显示 empty 提示
  if (empty) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        {header}
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{empty}</p>
        </div>
      </div>
    )
  }

  // 正常内容：header + 其余子元素
  return (
    <div className={cn('h-full flex flex-col', className)}>
      {header}
      {otherChildren}
    </div>
  )
}

function Info_PageHeader({ className, ...props }: Info_PageHeaderProps) {
  return <PanelHeader className={className} {...props} />
}

function Info_PageHero({ avatar, title, tagline, className }: Info_PageHeroProps) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <div className="h-[32px] w-[32px] shrink-0 mt-[2px] rounded-[4px] ring-1 ring-border/30 overflow-hidden">
        {avatar}
      </div>
      <div className="flex-1 min-w-0">
        {title && (
          <h2 className="text-base font-semibold text-foreground leading-tight">
            {title}
          </h2>
        )}
        {tagline && (
          <p className={cn('text-sm text-foreground/60 leading-snug line-clamp-1', title ? 'mt-0.5' : 'mt-0')}>
            {tagline}
          </p>
        )}
      </div>
    </div>
  )
}

function Info_PageContent({ children, className }: Info_PageContentProps) {
  return (
    <div className="relative flex-1 min-h-0">
      {/* 遮罩容器：在透明或图片背景上，让内容在顶部和底部产生渐隐效果 */}
      <div
        className="h-full"
        style={{
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
        }}
      >
        <ScrollArea className="h-full">
          <div className={cn(CHAT_LAYOUT.maxWidth, 'mx-auto px-5 pt-6 pb-10')}>
            <div className={cn('space-y-6', className)}>{children}</div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export const Info_Page = Object.assign(Info_PageRoot, {
  Header: Info_PageHeader,
  Hero: Info_PageHero,
  Content: Info_PageContent,
})
