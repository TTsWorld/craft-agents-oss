/**
 * UnifiedDiffViewer - 用于预计算 unified diff 字符串的 diff 查看器
 *
 * 用于 Codex 文件操作，后者提供 unified diff patch
 * 而非原始/修改后的内容字符串。
 *
 * 使用 @pierre/diffs 的 parsePatchFiles 解析 unified diff 字符串，
 * 并通过 FileDiff 组件渲染，支持正确主题。
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { FileDiff, type FileDiffProps } from '@pierre/diffs/react'
import { parsePatchFiles, DIFFS_TAG_NAME, registerCustomTheme, resolveTheme, type FileDiffMetadata } from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { LANGUAGE_MAP } from './language-map'

// 若尚未注册则注册 diffs-container 自定义元素
// （与 ShikiDiffViewer 共享——多次调用安全）
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

// 自定义主题在 ShikiDiffViewer 中注册，跨组件共享

export interface UnifiedDiffViewerProps {
  /** 原始 unified diff 字符串（例如来自 Codex fileChange.diff） */
  unifiedDiff: string
  /** 文件路径——用于头部展示 */
  filePath?: string
  /** diff 样式：'unified'（堆叠）或 'split'（并排） */
  diffStyle?: 'unified' | 'split'
  /** 主题模式 */
  theme?: 'light' | 'dark'
  /** Shiki 主题名（例如 'dracula'、'github-dark'）。提供时使用对应的 Shiki 原生主题；
   *  未设置时回退到 craft-dark/craft-light（透明背景）。 */
  shikiTheme?: string
  /** 禁用变更行的背景高亮 */
  disableBackground?: boolean
  /** 是否隐藏 pierre 原生文件头（文件名 + 统计）。默认 true */
  disableFileHeader?: boolean
  /** 文件头被点击时的回调（例如在编辑器中打开文件）。
   *  提供时文件头变为可点击，cursor: pointer。 */
  onFileHeaderClick?: (filePath: string) => void
  /** 就绪时的回调 */
  onReady?: () => void
  /** 额外类名 */
  className?: string
}

/**
 * 将 unified diff 字符串解析为 FileDiffMetadata。
 * 处理空 diff 或格式错误 patch 等边界情况。
 */
function parseUnifiedDiff(unifiedDiff: string, filePath: string): FileDiffMetadata | null {
  if (!unifiedDiff || !unifiedDiff.trim()) {
    return null
  }

  try {
    // parsePatchFiles 期望完整的 patch 格式
    // 若 diff 没有正确的头部，可能需要补一个
    let patchContent = unifiedDiff

    // 检查是否为无文件头的裸 hunk
    // 正确的 unified diff 以 "---" 或 "diff --git" 开头
    if (!patchContent.startsWith('---') && !patchContent.startsWith('diff ')) {
      // 包装为最小化的 unified diff 格式
      patchContent = `--- a/${filePath}\n+++ b/${filePath}\n${patchContent}`
    }

    const patches = parsePatchFiles(patchContent)
    const firstPatch = patches[0]
    if (firstPatch && firstPatch.files.length > 0) {
      const firstFile = firstPatch.files[0]
      return firstFile ?? null
    }
    return null
  } catch (e) {
    console.warn('[UnifiedDiffViewer] Failed to parse unified diff:', e)
    return null
  }
}

/**
 * UnifiedDiffViewer - 渲染预计算的 unified diff 字符串
 */
export function UnifiedDiffViewer({
  unifiedDiff,
  filePath = 'file',
  diffStyle = 'unified',
  theme = 'light',
  shikiTheme,
  disableBackground = false,
  disableFileHeader = true,
  onFileHeaderClick,
  onReady,
  className,
}: UnifiedDiffViewerProps) {
  const hasCalledReady = useRef(false)
  const [isReady, setIsReady] = useState(false)

  // 解析 unified diff
  const fileDiff = useMemo(() => {
    return parseUnifiedDiff(unifiedDiff, filePath)
  }, [unifiedDiff, filePath])

  // diff 选项——若有 app 的 Shiki 主题则使用，否则回退到
  // craft-dark/craft-light（透明背景，支持 CSS 变量主题）
  const resolvedThemeName = shikiTheme || (theme === 'dark' ? 'craft-dark' : 'craft-light')

  // 提供 onFileHeaderClick 时，注入 CSS 使头部看起来可点击
  const unsafeCSS = onFileHeaderClick
    ? '[data-diffs-header] { cursor: pointer; } [data-diffs-header]:hover [data-title] { text-decoration: underline; }'
    : undefined

  const options: FileDiffProps<undefined>['options'] = useMemo(() => ({
    theme: resolvedThemeName,
    diffStyle,
    diffIndicators: 'bars',
    disableBackground,
    lineDiffType: 'word',
    overflow: 'scroll',
    disableFileHeader,
    themeType: theme === 'dark' ? 'dark' : 'light',
    unsafeCSS,
  }), [resolvedThemeName, theme, diffStyle, disableBackground, disableFileHeader, unsafeCSS])

  // 首次渲染后调用 onReady
  useEffect(() => {
    if (!hasCalledReady.current && onReady) {
      hasCalledReady.current = true
      // 给 Shiki 高亮留出时间
      const timer = setTimeout(() => {
        setIsReady(true)
        onReady()
      }, 100)
      return () => {
        clearTimeout(timer)
        hasCalledReady.current = false // 重置，使重新挂载（含 StrictMode）能重新启动定时器
      }
    }
  }, [onReady, unifiedDiff, fileDiff])

  // 在 pierre 的 shadow DOM 内为文件头附加点击监听器。
  const containerRef = useRef<HTMLDivElement>(null)
  const onFileHeaderClickRef = useRef(onFileHeaderClick)
  onFileHeaderClickRef.current = onFileHeaderClick

  useEffect(() => {
    if (!onFileHeaderClick || disableFileHeader) return

    // 短暂等待 pierre 将头部渲染进 shadow DOM
    const timer = setTimeout(() => {
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (!header) return

      const handleClick = () => {
        onFileHeaderClickRef.current?.(filePath)
      }
      header.addEventListener('click', handleClick)
      // 存储清理引用以便移除监听器
      ;(header as any).__craftClickCleanup = () => header.removeEventListener('click', handleClick)
    }, 150)

    return () => {
      clearTimeout(timer)
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (header) {
        ;(header as any).__craftClickCleanup?.()
      }
    }
  }, [filePath, disableFileHeader, onFileHeaderClick])

  // 使用 CSS 变量以尊重自定义主题
  const backgroundColor = 'var(--background)'

  // 若无法解析 diff，展示兜底内容
  if (!fileDiff) {
    return (
      <div
        ref={containerRef}
        className={cn(
          'h-full w-full overflow-auto p-4',
          className
        )}
        style={{
          backgroundColor,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <pre className="text-foreground/70 whitespace-pre-wrap">{unifiedDiff || '(empty diff)'}</pre>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'h-full w-full overflow-auto transition-opacity duration-200',
        className
      )}
      style={{
        backgroundColor,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <FileDiff
        fileDiff={fileDiff}
        options={options}
        className="min-h-full h-full"
      />
    </div>
  )
}

/**
 * 从 unified diff 字符串计算新增/删除统计。
 * 用于无需完整渲染即可在头部展示变更计数。
 */
export function getUnifiedDiffStats(unifiedDiff: string, filePath: string = 'file'): { additions: number; deletions: number } | null {
  const fileDiff = parseUnifiedDiff(unifiedDiff, filePath)
  if (!fileDiff) return null

  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionCount
    deletions += hunk.deletionCount
  }
  return { additions, deletions }
}
