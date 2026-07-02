/**
 * Info_Markdown
 *
 * 统一样式的 Markdown 内容展示组件，会自动检测内容是否以标题开头并调整顶部内边距。
 * 支持全屏查看，复用 @craft-agent/ui 中的 DocumentFormattedMarkdownOverlay。
 */

import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2 } from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { DocumentFormattedMarkdownOverlay } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

export interface Info_MarkdownProps {
  /** Markdown 内容字符串 */
  children: string
  /** 最大高度，超出后会出现纵向滚动条 */
  maxHeight?: number
  /** Markdown 渲染模式：minimal（精简）或 full（完整） */
  mode?: 'minimal' | 'full'
  className?: string
  /** 是否启用全屏按钮（hover 时显示 Maximize2 图标） */
  fullscreen?: boolean
}

export function Info_Markdown({
  children,
  maxHeight,
  mode = 'minimal',
  className,
  fullscreen = false,
}: Info_MarkdownProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)

  // 检测内容是否以一级到三级标题（# / ## / ###）开头
  const startsWithHeading = children.trimStart().match(/^#{1,3}\s/)

  return (
    <>
      <div
        className={cn(
          'px-6 pb-3 text-sm',
          maxHeight && 'overflow-y-auto',
          startsWithHeading ? 'pt-0' : 'pt-1',
          // 为全屏按钮定位添加 relative + group 类
          fullscreen && 'relative group',
          className
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {/* 全屏按钮：hover 时显示，定位在右上角 */}
        {fullscreen && (
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              'absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10',
              'opacity-0 group-hover:opacity-100',
              'bg-background shadow-minimal',
              'text-muted-foreground/50 hover:text-foreground',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100'
            )}
            title={t("table.viewFullscreen")}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}

        <Markdown mode={mode}>{children}</Markdown>
      </div>

      {/* 全屏弹窗 overlay：复用 packages/ui 中的共享组件 */}
      {fullscreen && (
        <DocumentFormattedMarkdownOverlay
          content={children}
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
        />
      )}
    </>
  )
}
