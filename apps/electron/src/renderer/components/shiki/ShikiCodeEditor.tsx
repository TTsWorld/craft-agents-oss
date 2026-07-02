/**
 * ShikiCodeEditor - 基于 react-simple-code-editor 的可编辑代码/ Markdown 编辑器
 *
 * 用更轻量的方案替代 Monaco Editor 来编辑 Markdown。
 * 底层使用 textarea 覆盖技术，配合 Shiki 做语法高亮。
 *
 * 主要功能：
 * - 通过 Shiki 实现语法高亮
 * - 支持浅色/深色主题
 * - 自动缩进（Tab 键）
 * - 支持只读模式
 */

import * as React from 'react'
import { useState, useEffect, useCallback, useRef } from 'react'
import Editor from 'react-simple-code-editor'
import { codeToHtml, bundledLanguages, type BundledLanguage } from 'shiki'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'

// props 接口：定义组件对外开放的能力，类似 Go 里某个函数的结构化参数
export interface ShikiCodeEditorProps {
  /** 代码 / Markdown 内容 */
  value: string
  /** 语法高亮语言（默认 'markdown'） */
  language?: string
  /** 内容变化时的回调函数 */
  onChange?: (value: string) => void
  /** 是否为只读模式 */
  readOnly?: boolean
  /** 编辑器准备就绪时的回调函数 */
  onReady?: () => void
  /** 额外的 CSS 类名 */
  className?: string
  /** 内容为空时显示的占位文本（UI 文案，保持原样不翻译） */
  placeholder?: string
}

// 语言别名映射：把常见缩写转成 Shiki 能识别的语言名
const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  'md': 'markdown',
  'js': 'javascript',
  'ts': 'typescript',
}

// 校验传入的语言是否被 Shiki 内置支持
function isValidLanguage(lang: string): lang is BundledLanguage {
  const normalized = LANGUAGE_ALIASES[lang] || lang
  return normalized in bundledLanguages
}

// 简单的高亮结果缓存，避免重复渲染时反复调用 Shiki
const highlightCache = new Map<string, string>()
const CACHE_MAX_SIZE = 50

// 生成缓存 key：长文本用长度+首尾片段做摘要，短文本直接用原始内容
function getCacheKey(code: string, lang: string, theme: string): string {
  // 内容较长时，用长度和首尾 100 个字符拼一个简化的 key
  if (code.length > 500) {
    const hash = code.length.toString() + code.substring(0, 100) + code.substring(code.length - 100)
    return `${theme}:${lang}:${hash}`
  }
  return `${theme}:${lang}:${code}`
}

/**
 * ShikiCodeEditor - 轻量带语法高亮的编辑器组件
 *
 * 说明：
 * - useState / useRef / useCallback / useEffect 是 React Hooks，
 *   分别用于状态、可变引用、缓存函数、副作用，可类比 Go 中闭包+状态机的组合。
 * - React/TSX 的返回值是 JSX，描述 UI 长什么样，不是字符串模板。
 */
export function ShikiCodeEditor({
  value,
  language = 'markdown',
  onChange,
  readOnly = false,
  onReady,
  className,
  placeholder,
}: ShikiCodeEditorProps) {
  // useTheme() 读取当前 Electron renderer 进程的主题上下文
  const { isDark, shikiTheme } = useTheme()
  // useRef 用来记录是否已经触发过一次 onReady，避免重复调用
  const hasCalledReady = useRef(false)
  // 当前已经高亮好的 HTML 片段
  const [highlightedCode, setHighlightedCode] = useState<string>('')

  // 把语言别名解析成 Shiki 支持的语言名
  const resolvedLang = LANGUAGE_ALIASES[language.toLowerCase()] || language.toLowerCase()
  // 使用主题上下文中的 Shiki 主题
  const theme = shikiTheme

  // 高亮函数：异步调用 Shiki 把代码转成 HTML
  const highlight = useCallback(async (code: string): Promise<string> => {
    if (!code) return ''

    const cacheKey = getCacheKey(code, resolvedLang, theme)
    const cached = highlightCache.get(cacheKey)
    if (cached) return cached

    try {
      // 如果语言不被支持，就降级成纯文本
      const lang = isValidLanguage(resolvedLang) ? resolvedLang : 'text'
      const html = await codeToHtml(code, { lang, theme })

      // 只取 <pre><code>...</code></pre> 内部的内容
      // Shiki 返回格式：<pre class="..." style="..."><code>...</code></pre>
      const match = html.match(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/)
      const content = match ? match[1] : code

      // LRU 策略：缓存超过上限时删除最早插入的一条
      if (highlightCache.size >= CACHE_MAX_SIZE) {
        const firstKey = highlightCache.keys().next().value
        if (firstKey) highlightCache.delete(firstKey)
      }
      highlightCache.set(cacheKey, content)

      return content
    } catch (error) {
      console.warn(`Shiki highlighting failed:`, error)
      return code
    }
  }, [resolvedLang, theme])

  // 初始高亮：value 或 highlight 变化时重新渲染
  useEffect(() => {
    let cancelled = false

    async function doHighlight() {
      const result = await highlight(value)
      if (!cancelled) {
        setHighlightedCode(result)

        // 只在第一次高亮完成后触发 onReady
        if (!hasCalledReady.current && onReady) {
          hasCalledReady.current = true
          requestAnimationFrame(() => onReady())
        }
      }
    }

    doHighlight()

    // 清理函数：组件卸载或依赖变化时取消上一次未完成的渲染
    return () => {
      cancelled = true
    }
  }, [value, highlight, onReady])

  // 处理编辑器内容变化
  const handleValueChange = useCallback((newValue: string) => {
    if (!readOnly && onChange) {
      onChange(newValue)
    }
  }, [readOnly, onChange])

  // 同步高亮包装层
  // react-simple-code-editor 需要一个同步的 highlight 函数，
  // 所以我们先返回缓存/纯文本，同时触发异步高亮，完成后更新状态。
  const syncHighlight = useCallback((code: string): string => {
    const cacheKey = getCacheKey(code, resolvedLang, theme)
    const cached = highlightCache.get(cacheKey)
    if (cached) return cached

    // 触发异步高亮，并在结果变化时更新 UI
    highlight(code).then(result => {
      if (result !== highlightedCode) {
        setHighlightedCode(result)
      }
    })

    // 如果已经有上一次高亮结果，先返回它；否则返回原始纯文本
    return highlightedCode || code
  }, [resolvedLang, theme, highlight, highlightedCode])

  // 背景色/文字色/占位符颜色，需与 CSS 变量 --background 保持一致
  const backgroundColor = isDark ? '#302f33' : '#faf9fb'
  const textColor = isDark ? '#d4d4d4' : '#1f1f1f'
  const placeholderColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'

  return (
    <div
      className={cn('h-full w-full overflow-auto', className)}
      style={{ backgroundColor }}
    >
      <Editor
        value={value}
        onValueChange={handleValueChange}
        highlight={syncHighlight}
        disabled={readOnly}
        padding={24}
        placeholder={placeholder}
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 14,
          lineHeight: 1.6,
          minHeight: '100%',
          backgroundColor,
          color: textColor,
        }}
        textareaClassName={cn(
          'focus:outline-none',
          readOnly && 'cursor-default'
        )}
        className="min-h-full"
      />
      <style>{`
        .npm__react-simple-code-editor__textarea::placeholder {
          color: ${placeholderColor};
        }
      `}</style>
    </div>
  )
}
