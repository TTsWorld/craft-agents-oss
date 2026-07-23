/**
 * MultiDiffPreviewOverlay - 多文件变更浮层（Edit/Write 工具）
 *
 * 布局：使用 pierre 原生文件头的堆叠 diff——类似 GitHub PR 的视图。
 * 每个 diff 通过 @pierre/diffs 渲染自己的文件头（文件名 + 增删行数）。
 * 无卡片外框或折叠——所有 diff 在单个滚动区域中可见。
 *
 * 功能：
 * - 带 pierre 原生文件头的堆叠 diff（无自定义卡片包裹）
 * - 合并视图（按文件分组）或独立变更
 * - 每个变更支持统一/分屏 diff 查看器
 * - 聚焦变更支持（打开时滚动到特定变更）
 * - 头部：单文件显示文件路径，多文件显示"N edits"摘要
 */

import * as React from 'react'
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { PencilLine, FilePlus, X } from 'lucide-react'
import { parseDiffFromFile, parsePatchFiles, type FileContents } from '@pierre/diffs'
import { ShikiDiffViewer, getDiffStats } from '../code-viewer/ShikiDiffViewer'
import { UnifiedDiffViewer, getUnifiedDiffStats } from '../code-viewer/UnifiedDiffViewer'
import { DiffViewerControls } from '../code-viewer/DiffViewerControls'
import { LANGUAGE_MAP } from '../code-viewer/language-map'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

/**
 * 单个文件变更（Edit 或 Write）
 *
 * 支持两种格式：
 * - Claude Code：original/modified 字符串（计算 diff）
 * - Codex：unifiedDiff 字符串（预计算的统一 diff 补丁）
 */
export interface FileChange {
  /** 此变更的唯一 ID */
  id: string
  /** 绝对文件路径 */
  filePath: string
  /** 工具类型：Edit 或 Write */
  toolType: 'Edit' | 'Write'
  /** Edit 时为 old_string；Write 时为空或可用的上一版本内容 */
  original: string
  /** Edit 时为 new_string；Write 时为写入的内容 */
  modified: string
  /** Codex 格式：原始统一 diff 字符串（与 original/modified 二选一） */
  unifiedDiff?: string
  /** 工具执行失败时的错误信息 */
  error?: string
}

/**
 * diff 查看器显示偏好
 * 由父级传入以避免使用 localStorage——所有设置存储在 preferences.json 中
 */
export interface DiffViewerSettings {
  diffStyle: 'unified' | 'split'
  disableBackground: boolean
}

export interface MultiDiffPreviewOverlayProps {
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 要显示的文件变更列表 */
  changes: FileChange[]
  /** 是否按文件路径合并变更（默认：true） */
  consolidated?: boolean
  /** 初始聚焦的变更 ID */
  focusedChangeId?: string
  /** 主题模式 */
  theme?: 'light' | 'dark'
  /** 内联渲染，不使用对话框（用于 playground） */
  embedded?: boolean
  /** 初始 diff 查看器设置（来自用户偏好） */
  diffViewerSettings?: Partial<DiffViewerSettings>
  /** diff 查看器设置变更时的回调（用于持久化到偏好） */
  onDiffViewerSettingsChange?: (settings: DiffViewerSettings) => void
}

// ============================================
// 辅助函数
// ============================================

/** 单个文件的变更组（或一个未分组的独立变更） */
interface FileSection {
  key: string
  filePath: string
  changes: FileChange[]
}

/**
 * 将变更按文件分组。
 * 合并模式下，同一文件的变更会被合并到一起。
 * 非合并模式下，每个变更为独立分组。
 */
function createFileSections(changes: FileChange[], consolidated: boolean): FileSection[] {
  if (!consolidated) {
    return changes.map(change => ({
      key: change.id,
      filePath: change.filePath,
      changes: [change],
    }))
  }

  // 按文件路径分组，保持首次出现的顺序
  const byPath = new Map<string, FileChange[]>()
  for (const change of changes) {
    const existing = byPath.get(change.filePath) || []
    existing.push(change)
    byPath.set(change.filePath, existing)
  }

  return Array.from(byPath.entries()).map(([filePath, fileChanges]) => ({
    key: filePath,
    filePath,
    changes: fileChanges,
  }))
}

/** 计算单个变更的 diff 统计 */
function computeChangeStats(change: FileChange): { additions: number; deletions: number } {
  // 处理 Codex 格式：统一 diff 字符串
  if (change.unifiedDiff) {
    const stats = getUnifiedDiffStats(change.unifiedDiff, change.filePath)
    return stats || { additions: 0, deletions: 0 }
  }

  // 处理 Claude Code 格式：original/modified 字符串
  const ext = change.filePath.split('.').pop()?.toLowerCase() || ''
  const lang = LANGUAGE_MAP[ext] || 'text'
  const oldFile: FileContents = { name: change.filePath, contents: change.original, lang: lang as any }
  const newFile: FileContents = { name: change.filePath, contents: change.modified, lang: lang as any }
  const fileDiff = parseDiffFromFile(oldFile, newFile)
  return getDiffStats(fileDiff)
}

// ============================================
// 主组件
// ============================================

export function MultiDiffPreviewOverlay({
  isOpen,
  onClose,
  changes,
  consolidated = true,
  focusedChangeId,
  theme = 'light',
  embedded,
  diffViewerSettings,
  onDiffViewerSettingsChange,
}: MultiDiffPreviewOverlayProps) {
  const { onOpenFileExternal } = usePlatform()

  // 用于滚动到聚焦变更的 ref 映射
  const changeRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // 构建文件分组（合并或非合并）
  const fileSections = useMemo(() => {
    return createFileSections(changes, consolidated)
  }, [changes, consolidated])

  // ── 淡入显示 ──────────────────────────────────────────────────
  // 内容初始不可见（opacity 0），等待 ShikiDiffViewers 加载完成
  // 且滚动位置就绪。当所有 diff 触发 onReady 且滚动完成后，
  // 通过 CSS 过渡显示内容。如果所有条件在首帧（约 50ms）内就绪，
  // 则跳过过渡直接显示。
  // 仅统计可见（非错误）的 diff 用于显示门控
  const diffCount = useMemo(() => changes.filter(c => !c.error).length, [changes])
  const readyCountRef = useRef(0)
  const scrollDoneRef = useRef(!focusedChangeId) // 无需滚动 → 已完成
  const revealedRef = useRef(false)
  const mountedAtRef = useRef(performance.now())
  const [contentVisible, setContentVisible] = useState(false)
  const [animateReveal, setAnimateReveal] = useState(true)

  const checkReveal = useCallback(() => {
    if (revealedRef.current) return
    if (readyCountRef.current >= diffCount && scrollDoneRef.current) {
      revealedRef.current = true
      // 若所有条件在首帧内满足，直接显示（无过渡）
      const elapsed = performance.now() - mountedAtRef.current
      if (elapsed < 50) setAnimateReveal(false)
      setContentVisible(true)
    }
  }, [diffCount])

  const handleDiffReady = useCallback(() => {
    readyCountRef.current++
    checkReveal()
  }, [checkReveal])

  // 挂载时检查显示——处理 diffCount=0（全部错误）等边界情况
  useEffect(() => {
    checkReveal()
  }, [checkReveal])

  // diff 查看器控件状态——从属性初始化（用户偏好）
  // 设置通过 onDiffViewerSettingsChange 回调持久化到 preferences.json
  const [diffStyle, setDiffStyleInternal] = useState<'unified' | 'split'>(
    diffViewerSettings?.diffStyle ?? 'unified'
  )
  const [disableBackground, setDisableBackgroundInternal] = useState(
    diffViewerSettings?.disableBackground ?? false
  )

  // 包装 setter 以同时调用持久化回调
  const setDiffStyle = useCallback((style: 'unified' | 'split') => {
    setDiffStyleInternal(style)
    onDiffViewerSettingsChange?.({ diffStyle: style, disableBackground })
  }, [disableBackground, onDiffViewerSettingsChange])

  const setDisableBackground = useCallback((disabled: boolean) => {
    setDisableBackgroundInternal(disabled)
    onDiffViewerSettingsChange?.({ diffStyle, disableBackground: disabled })
  }, [diffStyle, onDiffViewerSettingsChange])

  // 计算浮层头部的 diff 总统计
  const totalStats = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const change of changes) {
      if (change.error) continue
      const stats = computeChangeStats(change)
      additions += stats.additions
      deletions += stats.deletions
    }
    return { additions, deletions }
  }, [changes])

  // 挂载后滚动到聚焦变更，然后标记滚动完成以触发显示
  useEffect(() => {
    if (!focusedChangeId) {
      scrollDoneRef.current = true
      checkReveal()
      return
    }

    // 小延迟以等待 ShikiDiffViewer 渲染（异步语法高亮）
    const timer = setTimeout(() => {
      const el = changeRefs.current.get(focusedChangeId)
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'start' })
      }
      scrollDoneRef.current = true
      checkReveal()
    }, 150)

    return () => clearTimeout(timer)
  }, [focusedChangeId, checkReveal])

  // 根据单文件还是多文件确定头部内容
  const isMultiFile = fileSections.length > 1
  const totalChangeCount = fileSections.reduce((acc, s) => acc + s.changes.length, 0)

  // 类型徽标：单文件显示 Edit/Write；多文件显示编辑计数
  const typeBadge = useMemo((): { icon: typeof PencilLine; label: string; variant: BadgeVariant } => {
    const hasWrite = changes.some(c => c.toolType === 'Write' && !c.error)
    if (isMultiFile) {
      return {
        icon: hasWrite ? FilePlus : PencilLine,
        label: `${totalChangeCount} edit${totalChangeCount !== 1 ? 's' : ''}`,
        variant: hasWrite ? 'green' : 'orange',
      }
    }
    // 单文件——变更数大于 1 时显示工具类型和计数
    const firstSection = fileSections[0]
    if (!firstSection) return { icon: PencilLine, label: 'Edit', variant: 'orange' }
    const sectionHasWrite = firstSection.changes.some(c => c.toolType === 'Write')
    const count = firstSection.changes.length
    return {
      icon: sectionHasWrite ? FilePlus : PencilLine,
      label: count > 1
        ? `${count} ${sectionHasWrite ? 'Write' : 'Edit'}s`
        : (sectionHasWrite ? 'Write' : 'Edit'),
      variant: sectionHasWrite ? 'green' : 'orange',
    }
  }, [changes, isMultiFile, totalChangeCount, fileSections])

  // 头部文件路径（单文件）或摘要标题（多文件）
  const headerFilePath = !isMultiFile ? fileSections[0]?.filePath : undefined
  const headerTitle = isMultiFile
    ? `${totalChangeCount} edit${totalChangeCount !== 1 ? 's' : ''} across ${fileSections.length} file${fileSections.length !== 1 ? 's' : ''}`
    : undefined

  // 头部操作：diff 总统计 + 查看器控件
  const headerActions = (
    <DiffViewerControls
      additions={totalStats.additions}
      deletions={totalStats.deletions}
      diffStyle={diffStyle}
      onDiffStyleChange={setDiffStyle}
      disableBackground={disableBackground}
      onBackgroundChange={setDisableBackground}
    />
  )

  // ref 回调，注册每个变更元素以支持滚动定位
  const setChangeRef = useCallback((changeId: string, el: HTMLDivElement | null) => {
    if (el) {
      changeRefs.current.set(changeId, el)
    } else {
      changeRefs.current.delete(changeId)
    }
  }, [])

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={typeBadge}
      filePath={headerFilePath}
      title={headerTitle}
      headerActions={headerActions}
      embedded={embedded}
      className="bg-foreground-3"
    >
      {/* 堆叠 diff——在父级滚动容器内流式布局。
          所有 diff 加载完成且滚动位置就绪前隐藏（淡入显示）。 */}
      <div
        className={cn(
          "flex px-6 min-h-full",
          animateReveal && "transition-opacity duration-150"
        )}
        style={{ opacity: contentVisible ? 1 : 0 }}
      >
        <div className="m-auto" style={{ width: 'max-content', maxWidth: '100%', minWidth: 'min(850px, 100%)' }}>
          {/* 堆叠 diff：每个 ShikiDiffViewer 渲染时带 pierre 的原生文件头。
              无卡片外框或折叠——连续堆叠布局，类似 GitHub PR diff。 */}
          <div className="flex flex-col gap-4">
            {fileSections.map((section) => (
              <div key={section.key} className="flex flex-col gap-4">
                {section.changes.map((change) => (
                  <div
                    key={change.id}
                    ref={(el) => setChangeRef(change.id, el)}
                    className="rounded-xl overflow-hidden bg-background shadow-minimal"
                    style={{ minHeight: change.error ? undefined : 200, borderRadius: 12 }}
                  >
                    {change.error ? (
                      // 出错的变更——带色调的错误横幅
                      <div className="px-4 py-4">
                        <div
                          className="flex items-start gap-3 px-4 py-3 rounded-[8px] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted"
                          style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
                        >
                          <X className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-destructive/70 mb-0.5">
                              {change.toolType} Failed
                            </div>
                            <p className="text-sm text-destructive whitespace-pre-wrap break-words">
                              {change.error}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : change.unifiedDiff ? (
                      // Codex 格式：预计算的统一 diff
                      <UnifiedDiffViewer
                        unifiedDiff={change.unifiedDiff}
                        filePath={change.filePath}
                        diffStyle={diffStyle}
                        disableBackground={disableBackground}
                        disableFileHeader={false}
                        onFileHeaderClick={onOpenFileExternal}
                        theme={theme}
                        onReady={handleDiffReady}
                      />
                    ) : (
                      // Claude Code 格式：original/modified 字符串
                      <ShikiDiffViewer
                        original={change.original}
                        modified={change.modified}
                        filePath={change.filePath}
                        diffStyle={diffStyle}
                        disableBackground={disableBackground}
                        disableFileHeader={false}
                        onFileHeaderClick={onOpenFileExternal}
                        theme={theme}
                        onReady={handleDiffReady}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </PreviewOverlay>
  )
}
