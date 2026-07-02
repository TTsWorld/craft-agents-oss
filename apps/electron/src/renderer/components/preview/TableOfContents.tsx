import * as React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'

// 单个目录条目（类似 Golang struct）
interface TocHeading {
  text: string   // 标题纯文本
  level: number  // 标题级别 h1=1, h2=2 ... h6=6
  line: number   // 所在行号（Monaco 编辑器使用 1-based）
}

// 组件 props 定义
interface TableOfContentsProps {
  content: string
  cursorLine: number
  onHeadingClick: (line: number) => void
  className?: string
}

/**
 * 去掉 Markdown 标记，得到纯文本标题。
 * 处理：图片、链接、粗体、斜体、行内代码、删除线。
 */
function stripMarkdown(text: string): string {
  return text
    // 图片 ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 链接 [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 粗体 **text** 或 __text__
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // 斜体 *text* 或 _text_
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // 行内代码 `code`
    .replace(/`([^`]+)`/g, '$1')
    // 删除线 ~~text~~
    .replace(/~~([^~]+)~~/g, '$1')
    // 去掉首尾空白
    .trim()
}

/**
 * TableOfContents：Markdown 目录组件，支持根据光标位置高亮当前标题。
 *
 * 功能：
 * - 从 Markdown 内容中提取标题及其行号
 * - 根据光标所在行高亮对应标题
 * - 点击标题后调用 onHeadingClick 回调，通知编辑器滚动到对应行
 */
export function TableOfContents({
  content,
  cursorLine,
  onHeadingClick,
  className,
}: TableOfContentsProps) {
  const { t } = useTranslation()

  // useMemo：只在 content 变化时重新解析标题，避免每次渲染都重新计算
  const headings = useMemo(() => {
    const lines = content.split('\n')
    const extracted: TocHeading[] = []

    lines.forEach((line, index) => {
      // 匹配 1-6 个 # 开头的 Markdown 标题
      const match = line.match(/^(#{1,6})\s+(.+)$/)
      if (match) {
        extracted.push({
          text: stripMarkdown(match[2]),
          level: match[1].length,
          line: index + 1, // Monaco 编辑器行号从 1 开始
        })
      }
    })

    return extracted
  }, [content])

  // 根据光标行号找到当前应高亮的标题索引
  const activeHeadingIndex = useMemo(() => {
    if (headings.length === 0) return -1

    // 找到最后一个行号 <= 光标行号的标题
    let activeIndex = -1
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].line <= cursorLine) {
        activeIndex = i
      } else {
        break
      }
    }

    return activeIndex
  }, [headings, cursorLine])

  // 没有标题时显示空状态（UI 文案保留国际化 key，不翻译）
  if (headings.length === 0) {
    return (
      <div className={cn('h-full flex items-center justify-center p-4', className)}>
        <span className="text-xs text-muted-foreground">{t("tableOfContents.noHeadings")}</span>
      </div>
    )
  }

  // 以最小标题级别为基准计算缩进，保证最外层标题左对齐
  const minLevel = Math.min(...headings.map((h) => h.level))

  return (
    <ScrollArea className={cn('h-full', className)}>
      <div className="py-4 pr-4">
        <nav className="space-y-0.5">
          {headings.map((heading, index) => {
            const indent = (heading.level - minLevel) * 12
            const isActive = index === activeHeadingIndex

            return (
              <button
                key={`${heading.line}-${heading.text}`}
                onClick={() => onHeadingClick(heading.line)}
                className={cn(
                  'block w-full text-left text-[13px] py-1.5 px-3 rounded-md transition-colors',
                  'hover:bg-foreground/5',
                  isActive
                    ? 'text-foreground font-medium bg-foreground/5'
                    : 'text-muted-foreground'
                )}
                style={{ paddingLeft: `${12 + indent}px` }}
              >
                <span className="line-clamp-2">{heading.text}</span>
              </button>
            )
          })}
        </nav>
      </div>
    </ScrollArea>
  )
}
