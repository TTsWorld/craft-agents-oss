/**
 * ShikiCodeViewer - 使用 Shiki 语法高亮的只读代码查看器
 *
 * 平台无关的代码展示组件，支持：
 * - 行号
 * - 通过 Shiki 的语法高亮
 * - 亮/暗主题支持
 * - 可滚动，带自定义滚动条样式
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef } from 'react'
import { codeToHtml, bundledLanguages, type BundledLanguage } from 'shiki'
import { cn } from '../../lib/utils'
import { LANGUAGE_MAP } from './language-map'

export interface ShikiCodeViewerProps {
  /** 要展示的代码内容 */
  code: string
  /** 语法高亮语言（未提供时从 filePath 自动检测） */
  language?: string
  /** 文件路径——未指定 language 时用于语言检测 */
  filePath?: string
  /** 起始行号（默认 1） */
  startLine?: number
  /** 主题模式 */
  theme?: 'light' | 'dark'
  /** Shiki 主题名（例如 'github-dark'、'dracula'）。默认根据主题模式使用 github-dark/github-light */
  shikiTheme?: string
  /** 就绪时的回调 */
  onReady?: () => void
  /** 额外类名 */
  className?: string
}

// 常见扩展名到 Shiki 语言名的映射
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

function isValidLanguage(lang: string): lang is BundledLanguage {
  const normalized = LANGUAGE_ALIASES[lang] || lang
  return normalized in bundledLanguages
}

function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_MAP[ext] || 'text'
}

/**
 * ShikiCodeViewer - 带行号的语法高亮代码查看器
 */
export function ShikiCodeViewer({
  code,
  language,
  filePath,
  startLine = 1,
  theme = 'light',
  shikiTheme,
  onReady,
  className,
}: ShikiCodeViewerProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const hasCalledReady = useRef(false)

  // 从 props 或文件路径解析语言
  const resolvedLang = useMemo(() => {
    const lang = language || (filePath ? getLanguageFromPath(filePath) : 'text')
    const lowered = lang.toLowerCase()
    return LANGUAGE_ALIASES[lowered] || lowered
  }, [language, filePath])

  // 将代码按行拆分以便生成行号
  const lines = useMemo(() => code.split('\n'), [code])

  // 用 Shiki 高亮代码
  useEffect(() => {
    let cancelled = false

    async function highlight() {
      // 使用提供的 shikiTheme，或根据模式回退到 github 主题
      const resolvedShikiTheme = shikiTheme || (theme === 'dark' ? 'github-dark' : 'github-light')
      const lang = isValidLanguage(resolvedLang) ? resolvedLang : 'text'

      try {
        const html = await codeToHtml(code, {
          lang,
          theme: resolvedShikiTheme,
        })

        if (!cancelled) {
          setHighlighted(html)
          setIsLoading(false)

          // 调用一次 onReady
          if (!hasCalledReady.current && onReady) {
            hasCalledReady.current = true
            requestAnimationFrame(() => onReady())
          }
        }
      } catch (error) {
        console.warn(`Shiki highlighting failed for language "${resolvedLang}":`, error)
        if (!cancelled) {
          setHighlighted(null)
          setIsLoading(false)

          if (!hasCalledReady.current && onReady) {
            hasCalledReady.current = true
            requestAnimationFrame(() => onReady())
          }
        }
      }
    }

    highlight()

    return () => {
      cancelled = true
    }
  }, [code, resolvedLang, theme, shikiTheme, onReady])

  // 使用 CSS 变量以尊重自定义主题
  const backgroundColor = 'var(--background)'
  const lineNumberColor = theme === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'
  const borderColor = theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'

  return (
    <div
      className={cn('h-full w-full overflow-auto', className)}
      style={{ backgroundColor }}
    >
      <div className="min-h-full flex">
        {/* 行号槽 */}
        <div
          className="sticky left-0 shrink-0 select-none text-right pr-4 pt-4 pb-4"
          style={{
            backgroundColor,
            borderRight: `1px solid ${borderColor}`,
            minWidth: '60px',
          }}
        >
          {lines.map((_, index) => (
            <div
              key={index}
              className="font-mono text-[13px] leading-[1.6] px-2"
              style={{ color: lineNumberColor }}
            >
              {startLine + index}
            </div>
          ))}
        </div>

        {/* 代码内容 */}
        <div className="flex-1 min-w-0 p-4 overflow-x-auto">
          {isLoading || !highlighted ? (
            <pre className="font-mono text-[13px] leading-[1.6] whitespace-pre">
              <code>{code}</code>
            </pre>
          ) : (
            <div
              className={cn(
                'font-mono text-[13px] leading-[1.6]',
                '[&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:whitespace-pre',
                '[&_code]:!bg-transparent'
              )}
              style={{ fontFamily: '"JetBrains Mono", monospace' }}
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
