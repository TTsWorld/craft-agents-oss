import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { codeToHtml, bundledLanguages, type BundledLanguage } from 'shiki'
import { cn } from '../../lib/utils'
import { useShikiTheme } from '../../context/ShikiThemeContext'

export interface CodeBlockProps {
  code: string
  language?: string
  className?: string
  /**
   * 渲染模式,影响代码块的样式:
   * - 'terminal':极简风格,保留控制字符可见
   * - 'minimal':干净的代码,基础样式
   * - 'full':富样式,带背景、复制按钮等
   */
  mode?: 'terminal' | 'minimal' | 'full'
  /**
   * 强制指定主题。若未提供,则从 document.documentElement.classList 检测
   */
  forcedTheme?: 'light' | 'dark'
}

// 预加载的语言(聊天场景中最常见)
const PRELOADED_LANGUAGES = [
  'javascript', 'typescript', 'python', 'json', 'bash', 'shell',
  'markdown', 'html', 'css', 'sql', 'yaml', 'go', 'rust', 'java',
  'c', 'cpp', 'tsx', 'jsx', 'swift', 'kotlin', 'ruby', 'php'
] as const

// 将常见别名映射到 Shiki 语言名
const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'sh': 'bash',
  'zsh': 'bash',
  'yml': 'yaml',
  'rb': 'ruby',
  'rs': 'rust',
  'kt': 'kotlin',
  'objective-c': 'objc',
  'objc': 'objc',
}

// 高亮结果的简易 LRU 缓存
const highlightCache = new Map<string, string>()
const CACHE_MAX_SIZE = 200

function getCacheKey(code: string, lang: string, theme: string): string {
  return `${theme}:${lang}:${code}`
}

function isValidLanguage(lang: string): lang is BundledLanguage {
  const normalized = LANGUAGE_ALIASES[lang] || lang
  return normalized in bundledLanguages
}

/**
 * CodeBlock - 基于 Shiki 的语法高亮代码块
 *
 * 使用 VS Code 的语法高亮引擎,提供准确的高亮效果。
 * 懒加载高亮逻辑并缓存结果,以提升性能。
 */
export function CodeBlock({ code, language = 'text', className, mode = 'full', forcedTheme }: CodeBlockProps) {
  const { t } = useTranslation()
  const [highlighted, setHighlighted] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)

  // 从 context 获取 shiki 主题(由应用中的 ShikiThemeProvider 设置)。
  // 可正确处理诸如"系统浅色模式下使用纯暗色主题"这类边界情况。
  const contextShikiTheme = useShikiTheme()

  // 解析语言别名 - 保留为 string 以允许回退到 'text'
  const langLower = language.toLowerCase()
  const resolvedLang: string = LANGUAGE_ALIASES[langLower] || langLower

  React.useEffect(() => {
    let cancelled = false

    async function highlight() {
      // 主题优先级:
      // 1. Context 主题(来自 ShikiThemeProvider) - 正确处理 supportedModes
      // 2. forcedTheme prop - 针对特定场景的显式覆盖
      // 3. DOM 检测回退 - 向后兼容的默认值
      let theme: string
      if (contextShikiTheme) {
        theme = contextShikiTheme
      } else if (forcedTheme) {
        theme = forcedTheme === 'dark' ? 'github-dark' : 'github-light'
      } else {
        const isDark = document.documentElement.classList.contains('dark')
        theme = isDark ? 'github-dark' : 'github-light'
      }
      const cacheKey = getCacheKey(code, resolvedLang, theme)

      const cached = highlightCache.get(cacheKey)
      if (cached) {
        if (!cancelled) {
          setHighlighted(cached)
          setIsLoading(false)
        }
        return
      }

      try {
        // 使用合法语言,否则回退到纯文本
        const lang = isValidLanguage(resolvedLang) ? resolvedLang : 'text'

        const html = await codeToHtml(code, {
          lang,
          theme,
        })

        // 缓存结果
        if (highlightCache.size >= CACHE_MAX_SIZE) {
          const firstKey = highlightCache.keys().next().value
          if (firstKey) highlightCache.delete(firstKey)
        }
        highlightCache.set(cacheKey, html)

        if (!cancelled) {
          setHighlighted(html)
          setIsLoading(false)
        }
      } catch (error) {
        // 出错时回退到纯文本
        console.warn(`Shiki highlighting failed for language "${resolvedLang}":`, error)
        if (!cancelled) {
          setHighlighted(null)
          setIsLoading(false)
        }
      }
    }

    highlight()

    return () => {
      cancelled = true
    }
  }, [code, resolvedLang, forcedTheme, contextShikiTheme])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }, [code])

  // terminal 模式:原始等宽字体,极简样式
  if (mode === 'terminal') {
    return (
      <pre className={cn('font-mono text-sm whitespace-pre-wrap', className)}>
        <code>{code}</code>
      </pre>
    )
  }

  // minimal 模式:仅语法高亮,无额外装饰
  if (mode === 'minimal') {
    if (isLoading || !highlighted) {
      return (
        <pre className={cn('font-mono text-sm whitespace-pre-wrap', className)}>
          <code>{code}</code>
        </pre>
      )
    }

    return (
      <div
        className={cn('font-mono text-sm [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-all [&_code]:!bg-transparent', className)}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    )
  }

  // full 模式:带头部和复制按钮的富样式
  return (
    <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/30', className)}>
      {/* 语言标签 + 复制按钮 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b text-xs">
        <span className="text-muted-foreground font-medium uppercase tracking-wide">
          {resolvedLang !== 'text' ? resolvedLang : 'plain text'}
        </span>
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
          aria-label={t('common.copyCode')}
        >
          {copied ? (
            <svg className="w-4 h-4 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      </div>

      {/* 代码内容 */}
      <div className="p-3 overflow-x-auto">
        {isLoading || !highlighted ? (
          <pre className="font-mono text-sm whitespace-pre-wrap break-all">
            <code>{code}</code>
          </pre>
        ) : (
          <div
            className="font-mono text-sm [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-all [&_code]:!bg-transparent"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * InlineCode - 带样式的行内代码片段
 * 特点:淡淡的背景(3%)、无边框、文字 75% 不透明度
 */
export function InlineCode({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code className={cn(
      'pl-1 pr-1 py-0 rounded bg-foreground/[0.04] font-mono text-[13px]',
      className
    )}>
      {children}
    </code>
  )
}
