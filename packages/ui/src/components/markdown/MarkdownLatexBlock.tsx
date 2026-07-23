import * as React from 'react'
import katex from 'katex'
import { cn } from '../../lib/utils'

interface MarkdownLatexBlockProps {
  code: string
  className?: string
}

/**
 * MarkdownLatexBlock - 将 ```latex / ```math 代码围栏渲染为展示型数学公式。
 *
 * 使用 KaTeX 把 LaTeX 源码渲染为带样式的 HTML。
 * 解析出错时显示原始源码及错误信息。
 */
export function MarkdownLatexBlock({ code, className }: MarkdownLatexBlockProps) {
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(code.trim(), {
        displayMode: true,
        throwOnError: false,
        strict: false,
      })
    } catch {
      return null
    }
  }, [code])

  if (!html) {
    return (
      <pre className={cn('font-mono text-sm whitespace-pre-wrap text-destructive', className)}>
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div
      className={cn('overflow-x-auto py-2', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
