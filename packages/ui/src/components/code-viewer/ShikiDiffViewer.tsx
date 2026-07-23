/**
 * ShikiDiffViewer - 使用 @pierre/diffs 的 diff 查看器（基于 Shiki）
 *
 * 平台无关的文件 diff 展示组件，支持：
 * - unified 或 split diff 视图
 * - 通过 Shiki 的语法高亮
 * - 亮/暗主题支持
 * - 行级 diff 高亮
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { FileDiff, type FileDiffMetadata, type FileDiffProps } from '@pierre/diffs/react'
import { parseDiffFromFile, DIFFS_TAG_NAME, type FileContents } from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { LANGUAGE_MAP } from './language-map'
import { registerCraftShikiThemes } from './registerShikiThemes'

// 若尚未注册则注册 diffs-container 自定义元素
// 这是必要的，因为 React 组件会渲染一个自定义元素
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

export interface ShikiDiffViewerProps {
  /** 原始（修改前）内容 */
  original: string
  /** 修改后（修改后）内容 */
  modified: string
  /** 文件路径——用于语言检测和展示 */
  filePath?: string
  /** 语法高亮语言（未提供时从 filePath 自动检测） */
  language?: string
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
 * 从 FileDiffMetadata 计算新增/删除统计。
 * 用于在头部展示变更计数
 */
export function getDiffStats(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionCount
    deletions += hunk.deletionCount
  }
  return { additions, deletions }
}

function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_MAP[ext] || 'text'
}

/**
 * ShikiDiffViewer - 基于 Shiki 的 diff 查看器组件
 */
export function ShikiDiffViewer({
  original,
  modified,
  filePath = 'file',
  language,
  diffStyle = 'unified',
  theme = 'light',
  shikiTheme,
  disableBackground = false,
  disableFileHeader = true,
  onFileHeaderClick,
  onReady,
  className,
}: ShikiDiffViewerProps) {
  const hasCalledReady = useRef(false)
  const [isReady, setIsReady] = useState(false)

  // 解析语言
  const resolvedLang = useMemo(() => {
    return language || getLanguageFromPath(filePath)
  }, [language, filePath])

  // 为 diff 解析器创建文件内容对象
  const oldFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: original,
    lang: resolvedLang as any,
  }), [filePath, original, resolvedLang])

  const newFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: modified,
    lang: resolvedLang as any,
  }), [filePath, modified, resolvedLang])

  // 解析 diff
  const fileDiff: FileDiffMetadata = useMemo(() => {
    return parseDiffFromFile(oldFile, newFile)
  }, [oldFile, newFile])

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
  }, [onReady, original, modified, fileDiff])

  // 在 pierre 的 shadow DOM 内为文件头附加点击监听器。
  // 我们查找 <diffs-container> 自定义元素，然后在其 shadowRoot 中找 [data-diffs-header]。
  // 这样无需修改 pierre 即可使文件名可点击。
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
