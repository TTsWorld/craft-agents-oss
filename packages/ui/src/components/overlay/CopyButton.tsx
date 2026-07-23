/**
 * CopyButton - 可复用的复制到剪贴板按钮，带反馈状态
 *
 * 初始显示"复制"，复制成功后显示"已复制！"并带勾选标记，持续 2 秒。
 * 用于浮层头部复制内容。
 */

import * as React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface CopyButtonProps {
  /** 要复制到剪贴板的内容 */
  content: string
  /** 可选标签（默认："Copy"） */
  label?: string
  /** 按钮的可选 tooltip */
  title?: string
  /** 可选 className 覆盖 */
  className?: string
}

export function CopyButton({ content, title, className }: CopyButtonProps) {
  const { t } = useTranslation()
  const resolvedTitle = title ?? t('common.copy')
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [content])

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'flex items-center justify-center w-7 h-7 rounded-[6px] transition-colors shrink-0 select-none',
        copied
          ? 'text-success'
          : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      title={copied ? t('common.copied') : resolvedTitle}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}
