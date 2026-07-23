/**
 * MarkdownJsonBlock - 用于 markdown 代码块的交互式 JSON 树查看器
 *
 * 当 markdown 查看器遇到 ```json 代码块时,本组件用与 JSONPreviewOverlay
 * 相同的 @uiw/react-json-view 配置和样式来渲染,而不是使用静态的 Shiki 语法高亮。
 *
 * - 将原始 code 字符串解析为 JSON
 * - 递归展开 JSON 中的字符串化 JSON(deepParseJson)
 * - 使用 craft 主题(透明背景、CSS 变量字体)
 * - 内联聊天场景默认 collapsed={2}
 * - 若 JSON 解析或渲染失败,则回退到 CodeBlock
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import JsonView from '@uiw/react-json-view'
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { Copy, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'

// ── 主题(与 JSONPreviewOverlay 一致) ────────────────────────────────────
// 透明背景,使容器的 bg-muted/30 能透出;
// 使用 CSS 变量字体,以匹配应用的等宽字体。

const craftAgentDarkTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

const craftAgentLightTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

// ── 深度解析辅助(与 JSONPreviewOverlay 一致) ─────────────────────────
// 递归解析 JSON 值中字符串化的 JSON,使 {"result": "{\"nested\": \"value\"}"}
// 这类嵌套对象显示为可展开节点。

function deepParseJson(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return deepParseJson(JSON.parse(trimmed))
      } catch {
        return value
      }
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map(deepParseJson)
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepParseJson(val)
    }
    return result
  }

  return value
}

// ── 错误边界 ────────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * 轻量错误边界,使 JsonView 失败时不会让整条消息崩溃 —— 而是回退到
 * 普通 CodeBlock。
 */
class JsonErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.warn('[MarkdownJsonBlock] JsonView render failed, falling back to CodeBlock:', error)
  }

  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

// ── 主组件 ────────────────────────────────────────────────────────────────

export interface MarkdownJsonBlockProps {
  /** 来自 markdown 代码块的原始 JSON 字符串 */
  code: string
  className?: string
}

export function MarkdownJsonBlock({ code, className }: MarkdownJsonBlockProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  // 尝试解析 —— 若是非法 JSON,回退到带语法高亮的 CodeBlock
  const parsed = React.useMemo(() => {
    try {
      const raw = JSON.parse(code)
      return deepParseJson(raw) as object
    } catch {
      return null
    }
  }, [code])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy JSON:', err)
    }
  }, [code])

  if (parsed === null) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const dark = isDarkMode()
  const jsonTheme = dark ? craftAgentDarkTheme : craftAgentLightTheme
  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  return (
    <JsonErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/30', className)}>
        {/* 标题栏 —— 与 CodeBlock full 模式一致(标签 + hover 时显示复制按钮) */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b text-xs">
          <span className="text-muted-foreground font-medium uppercase tracking-wide">json</span>
          <button
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
            aria-label={t('common.copyJson')}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* 交互式树形查看器 */}
        <div className="p-3 overflow-x-auto text-sm">
          <JsonView
            value={parsed}
            style={jsonTheme}
            collapsed={2}
            enableClipboard={true}
            displayDataTypes={false}
            shortenTextAfterLength={100}
          >
            {/* 自定义复制图标 —— 与 JSONPreviewOverlay 一致 */}
            <JsonView.Copied
              render={(props) => {
                const isCopied = (props as Record<string, unknown>)['data-copied']
                return isCopied ? (
                  <Check
                    className="ml-1.5 inline-flex cursor-pointer text-green-500"
                    size={10}
                    onClick={props.onClick}
                  />
                ) : (
                  <Copy
                    className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground"
                    size={10}
                    onClick={props.onClick}
                  />
                )
              }}
            />
          </JsonView>
        </div>
      </div>
    </JsonErrorBoundary>
  )
}
