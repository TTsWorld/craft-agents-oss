/**
 * MarkdownDiffBlock - 使用 @pierre/diffs 渲染 diff 代码块
 *
 * 当 markdown 查看器遇到 ```diff 代码块时,本组件用与全屏 diff 浮层
 * (ShikiDiffViewer)相同的 pierre/diffs 配置(PatchDiff)和样式来渲染,
 * 而不是使用普通的 Shiki 语法高亮。
 *
 * 处理常见的 diff 代码块格式:
 * 1. 标准的 unified diff(带 --- / +++ / @@ 头) — 直接传入
 * 2. 带行号但无文件头的 hunk — 前补合成的文件头
 * 3. 裸 diff 内容或裸 @@ 标记 — 前补合成的文件头
 *
 * 若 PatchDiff 渲染失败,则回退到普通 CodeBlock。
 */

import * as React from 'react'
import { PatchDiff, type PatchDiffProps } from '@pierre/diffs/react'
import { DIFFS_TAG_NAME } from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { ensureUnifiedDiffFormat } from './diff-normalize'
import { registerCraftShikiThemes } from '../code-viewer/registerShikiThemes'

// ── 自定义元素 + 主题注册(与 ShikiDiffViewer 一致) ──────────
// 幂等:即使 ShikiDiffViewer 已注册过,重复运行也安全。

if (typeof HTMLElement !== 'undefined' && !customElements.get(DIFFS_TAG_NAME)) {
  class FileDiffContainer extends HTMLElement {
    constructor() {
      super()
      if (this.shadowRoot != null) return
      this.attachShadow({ mode: 'open' })
    }
  }
  customElements.define(DIFFS_TAG_NAME, FileDiffContainer)
}

// 每个运行时注册一次自定义主题。
registerCraftShikiThemes()

// ── 辅助函数 ────────────────────────────────────────────────────────────────

/**
 * 通过检查 DOM class list 判断是否处于暗色模式。
 * 与 CodeBlock 中的回退逻辑保持一致。
 */
function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

// ── 错误边界 ────────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * 轻量错误边界,使 PatchDiff 失败时不会让整条消息崩溃 —— 而是回退到
 * 普通 CodeBlock。
 */
class DiffErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.warn('[MarkdownDiffBlock] PatchDiff render failed, falling back to CodeBlock:', error)
  }

  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── 主组件 ────────────────────────────────────────────────────────────────

export interface MarkdownDiffBlockProps {
  /** 来自 markdown 代码块的原始 diff 文本 */
  code: string
  className?: string
}

export function MarkdownDiffBlock({ code, className }: MarkdownDiffBlockProps) {
  const dark = isDarkMode()
  const themeName = dark ? 'craft-dark' : 'craft-light'

  // 构造与 ShikiDiffViewer 相同的 options,以保持视觉一致性
  const options: PatchDiffProps<undefined>['options'] = React.useMemo(() => ({
    theme: themeName,
    diffStyle: 'unified' as const,
    diffIndicators: 'bars' as const,
    disableBackground: false,
    lineDiffType: 'word' as const,
    overflow: 'scroll' as const,
    disableFileHeader: true,
    themeType: dark ? ('dark' as const) : ('light' as const),
  }), [themeName, dark])

  const patch = React.useMemo(() => ensureUnifiedDiffFormat(code), [code])

  const fallback = <CodeBlock code={code} language="diff" mode="full" className={className} />

  return (
    <DiffErrorBoundary fallback={fallback}>
      <div
        className={cn(
          'relative rounded-[8px] overflow-hidden border bg-muted/30',
          className,
        )}
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <PatchDiff patch={patch} options={options} />
      </div>
    </DiffErrorBoundary>
  )
}
