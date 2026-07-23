import * as React from 'react'
import { useMemo, useEffect, useRef, useCallback, useState } from 'react'
import i18n from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ToolDisplayMeta, AnnotationV1 } from '@craft-agent/core'
import { normalizePath, pathStartsWith, stripPathPrefix } from '@craft-agent/core/utils'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { motion, AnimatePresence } from 'motion/react'
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  Circle,
  MessageCircleDashed,
  FileText,
  ArrowUpRight,
  Ban,
  Copy,
  Check,
  Maximize2,
  CircleCheck,
  ListTodo,
  Pencil,
  FilePenLine,
  GitBranch,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { Markdown } from '../markdown'
import { Spinner } from '../ui/LoadingIndicator'
import { type IslandTransitionConfig } from '../ui'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import {
  type PointerSnapshot,
  buildAnnotationChipEntryTransition,
  buildSelectionEntryTransition,
} from '../annotations/island-motion'
import { Tooltip, TooltipTrigger, TooltipContent } from '../tooltip'
import { parseDiffFromFile, type FileContents } from '@pierre/diffs'
import { getDiffStats, getUnifiedDiffStats } from '../code-viewer'
import { TurnCardActionsMenu } from './TurnCardActionsMenu'
import { computeLastChildSet, groupActivitiesByParent, isActivityGroup, formatDuration, formatTokens, deriveTurnPhase, shouldShowThinkingIndicator, type ActivityGroup, type AssistantTurn } from './turn-utils'
import { extractAnnotationSelectedText } from './follow-up-helpers'
import {
  formatAnnotationFollowUpTooltipText,
  getAnnotationNoteText,
} from '../annotations/follow-up-state'
import {
  ANNOTATION_PREFIX_SUFFIX_WINDOW,
  SELECTION_POINTER_MAX_AGE_MS,
  clamp,
  hasExistingTextRangeAnnotation,
  createSelectionPreviewAnnotation,
  createTextSelectionAnnotation,
  collectTextSegments,
  getCanonicalText,
  resolveNodeOffset,
  type AnnotationOverlayRect,
} from '../annotations/annotation-core'
import {
  annotationColorToCss,
} from '../annotations/annotation-style-tokens'
import { clearBlockAnnotationMarkers, applyBlockAnnotationMarker } from '../annotations/block-markers'
import { canAnnotateMessage, shouldRenderAnnotationIslandInPortal } from '../annotations/annotation-host-config'
import { clearDomSelection } from '../annotations/selection-restore'
import {
  shouldIgnoreSelectionMouseUpTarget,
} from '../annotations/interaction-policy'
import { computeAnnotationOverlayGeometry, type AnnotationOverlayChip } from '../annotations/annotation-overlay-geometry'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import {
  getAnnotationInteractionAnchor,
  getAnnotationInteractionSourceKey,
  hasAnnotationInteraction,
} from '../annotations/interaction-selectors'
import {
  type AnnotationIslandMode,
  type AnchoredSelection,
} from '../annotations/interaction-state-machine'
import { useAnnotationInteractionController } from '../annotations/use-annotation-interaction-controller'
import { useAnnotationIslandPresentation } from '../annotations/use-annotation-island-presentation'
import { useAnnotationIslandEvents } from '../annotations/use-annotation-island-events'
import { useAnnotationCancelRestore } from '../annotations/use-annotation-cancel-restore'
import { DocumentFormattedMarkdownOverlay } from '../overlay'
import { AcceptPlanDropdown } from './AcceptPlanDropdown'
import { CompactAcceptPlanDrawer } from './CompactAcceptPlanDrawer'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 把 Markdown 文本剥离成纯文本预览。
 * 去掉 Markdown 语法，但保留代码块中的内容。
 */
function stripMarkdown(text: string): string {
  return text
    // 提取围栏代码块内容（去掉 ``` 和可选语言标识）
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1')
    // 提取行内代码内容
    .replace(/`([^`]+)`/g, '$1')
    // 去掉标题
    .replace(/^#{1,6}\s+/gm, '')
    // 去掉粗体/斜体
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // 去掉链接，只保留文本
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 去掉图片
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // 去掉引用
    .replace(/^>\s+/gm, '')
    // 去掉水平分隔线
    .replace(/^---+$/gm, '')
    // 合并空白
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 计算 Edit/Write 工具的 diff 统计。
 * 使用 @pierre/diffs 做逐行 diff 计算。
 *
 * 支持两种格式：
 * - Claude Code 格式：{ file_path, old_string, new_string }
 * - Codex 格式：{ changes: Array<{ path, kind, diff }> }
 *
 * @param toolName - 'Edit' 或 'Write'
 * @param toolInput - 包含 old_string/new_string（Edit）或 content（Write）的工具输入
 * @returns { additions, deletions } 或 null（不适用时）
 */
function computeEditWriteDiffStats(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): { additions: number; deletions: number } | null {
  if (!toolInput) return null

  if (toolName === 'Edit') {
    // 检查 Codex 格式：{ changes: Array<{ path, kind, diff }> }
    if (toolInput.changes && Array.isArray(toolInput.changes)) {
      let totalAdditions = 0
      let totalDeletions = 0
      for (const change of toolInput.changes as Array<{ path?: string; diff?: string }>) {
        if (change.diff) {
          const stats = getUnifiedDiffStats(change.diff, change.path || 'file')
          if (stats) {
            totalAdditions += stats.additions
            totalDeletions += stats.deletions
          }
        }
      }
      if (totalAdditions === 0 && totalDeletions === 0) return null
      return { additions: totalAdditions, deletions: totalDeletions }
    }

    // Claude Code 格式：{ file_path, old_string, new_string }
    const oldString = (toolInput.old_string as string) ?? ''
    const newString = (toolInput.new_string as string) ?? ''
    if (!oldString && !newString) return null

    const oldFile: FileContents = { name: 'file', contents: oldString, lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: newString, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  if (toolName === 'Write') {
    const content = (toolInput.content as string) ?? ''
    if (!content) return null

    // Write 工具：所有内容都是新增（新文件内容）
    const oldFile: FileContents = { name: 'file', contents: '', lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: content, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  return null
}

// ============================================================================
// 尺寸配置
// ============================================================================

/**
 * TurnCard 组件的全局尺寸配置。
 * 调整这些值可统一缩放整个组件。
 */
/** Activity UI 的共享尺寸配置，导出供 InlineExecution 复用 */
export const SIZE_CONFIG = {
  /** 所有文本的基础字号类名 */
  fontSize: 'text-[13px]',
  /** 图标尺寸类名（宽高） */
  iconSize: 'w-3 h-3',
  /** Spinner 文本字号类名 */
  spinnerSize: 'text-[10px]',
  /** 头部用的小 spinner */
  spinnerSizeSmall: 'text-[8px]',
  /** Activity 行高度（像素，用于计算） */
  activityRowHeight: 24,
  /** 滚动前最多可见 activity 数（约 15 个） */
  maxVisibleActivities: 15,
  /** 应用交错动画前的条目数阈值 */
  staggeredAnimationLimit: 10,
} as const

// ============================================================================
// 类型
// ============================================================================

export type ActivityStatus = 'pending' | 'running' | 'completed' | 'error' | 'backgrounded'
export type ActivityType = 'tool' | 'thinking' | 'intermediate' | 'status' | 'plan'
export type AnnotationInteractionMode = 'interactive' | 'tooltip-only'

// ============================================================================
// Todo 类型（用于 TodoWrite 工具可视化）
// ============================================================================

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'interrupted'

export interface TodoItem {
  /** 任务内容/描述 */
  content: string
  /** 当前状态 */
  status: TodoStatus
  /** in_progress 时显示的现在进行时文案（例如"Running tests"） */
  activeForm?: string
}

export interface ActivityItem {
  id: string
  type: ActivityType
  status: ActivityStatus
  toolName?: string
  toolUseId?: string  // 用于匹配父子关系
  toolInput?: Record<string, unknown>
  content?: string
  intent?: string
  /** 关联的底层消息 ID（plan activity 用于分支/批注） */
  messageId?: string
  /** 持久化批注（plan activity 使用） */
  annotations?: AnnotationV1[]
  displayName?: string  // LLM 生成的人类友好工具名（用于 MCP 工具）
  toolDisplayMeta?: ToolDisplayMeta  // 嵌入的元数据，含 base64 图标（兼容 viewer）
  timestamp: number
  error?: string
  // Task 子代理的父子嵌套
  parentId?: string  // 父 activity 的 toolUseId
  depth?: number     // 嵌套层级（0=根，1=子，依此类推）
  // 状态类型 activity（例如 compacting）
  statusType?: string  // 例如 'compacting'
  // 后台任务字段
  taskId?: string         // 后台 Task 工具使用
  shellId?: string        // 后台 Bash shell 使用
  elapsedSeconds?: number // 实时进度更新
  isBackground?: boolean  // 用于 UI 区分的标志
}

export interface ResponseContent {
  text: string
  isStreaming: boolean
  streamStartTime?: number
  /** 该响应是否为 plan（使用 plan 变体渲染） */
  isPlan?: boolean
  /** 底层消息 ID（用于分支与批注） */
  messageId?: string
  /** 附加在响应消息上的持久化批注 */
  annotations?: AnnotationV1[]
}

// ============================================================================
// TurnCard Props
// ============================================================================

export type OpenAnnotationRequest = {
  messageId: string
  annotationId: string
  mode: 'view' | 'edit'
  anchorX?: number
  anchorY?: number
  nonce: number
}

export interface TurnCardProps {
  /** 会话 ID，用于状态持久化（共享上下文中可选） */
  sessionId?: string
  /** Turn ID，用于状态持久化 */
  turnId: string
  /** 该 turn 的所有 activity（工具调用、思考过程、中间文本） */
  activities: ActivityItem[]
  /** 最终响应内容（可能正在流式输出） */
  response?: ResponseContent
  /** 该 turn 的主要意图/目标（折叠预览中展示） */
  intent?: string
  /** 是否仍在接收内容 */
  isStreaming: boolean
  /** 该 turn 是否已完全完成 */
  isComplete: boolean
  /** 初始展开状态 */
  defaultExpanded?: boolean
  /** 受控展开状态（覆盖内部状态） */
  isExpanded?: boolean
  /** 展开状态变化时的回调 */
  onExpandedChange?: (expanded: boolean) => void
  /** activity 分组的受控展开状态 */
  expandedActivityGroups?: Set<string>
  /** activity 分组展开状态变化时的回调 */
  onExpandedActivityGroupsChange?: (groups: Set<string>) => void
  /** 点击文件路径时的回调 */
  onOpenFile?: (path: string) => void
  /** 点击 URL 时的回调 */
  onOpenUrl?: (url: string) => void
  /** 在 Monaco 编辑器中打开响应的回调 */
  onPopOut?: (text: string) => void
  /** 在新窗口打开 turn 详情的回调 */
  onOpenDetails?: () => void
  /** 在 Monaco 中打开单个 activity 详情的回调 */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** 在多文件 diff 视图中打开所有编辑/写入的回调 */
  onOpenMultiFileDiff?: () => void
  /** 该 turn 是否包含任何 Edit 或 Write activity */
  hasEditOrWriteActivities?: boolean
  /** TodoWrite 工具状态，展示在 turn 底部 */
  todos?: TodoItem[]
  /** 可选的操作菜单渲染函数（Electron 提供下拉菜单） */
  renderActionsMenu?: () => React.ReactNode
  /** 用户接受计划时的回调（仅 plan 响应） */
  onAcceptPlan?: () => void
  /** 用户"接受并 Compact"时的回调（先 compact 对话再执行） */
  onAcceptPlanWithCompact?: () => void
  /** 是否为会话中最后一条响应（仅最后一条响应展示 Accept Plan 按钮） */
  isLastResponse?: boolean
  /** 会话文件夹路径，用于在工具展示中从文件路径里剔除该前缀 */
  sessionFolderPath?: string
  /** 展示模式：'detailed' 展示全部信息，'informative' 隐藏 MCP/API 名称和参数 */
  displayMode?: 'informative' | 'detailed'
  /** 响应出现时是否带动画（用于 playground 演示） */
  animateResponse?: boolean
  /** compact 页脚布局。用于 EditPopover（内嵌 popover）和自动 compact / WebUI 移动端的
   *  ChatPage。隐藏 Copy / Markdown / Branch 操作；当 plan 是最后一条响应时保留
   *  Accept Plan 下拉菜单。 */
  compactMode?: boolean
  /** 从指定消息开始分支会话的回调 */
  onBranch?: (messageId: string, options?: { newPanel?: boolean }) => void
  /** 为响应消息添加批注的回调 */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** 从响应消息移除持久化批注的回调 */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** 更新持久化批注的回调 */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** follow-up 编辑器使用的发送键行为 */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** 通过"Save & Send"保存 follow-up 时的回调 */
  onSaveAndSendFollowUp?: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  /** 会话中是否存在活跃的 pending follow-up 批注 */
  hasActiveFollowUpAnnotations?: boolean
  /** 在 follow-up island 中打开指定批注的外部请求 */
  openAnnotationRequest?: OpenAnnotationRequest | null
  /** 批注交互模式（viewer 使用 tooltip-only 以抑制 island） */
  annotationInteractionMode?: AnnotationInteractionMode
}

// ============================================================================
// 缓冲常量与工具函数
// ============================================================================

/**
 * 激进的缓冲配置。
 * 等到内容疑似为有意义的"评论"时才展示。
 */
const BUFFER_CONFIG = {
  MIN_WORDS_STANDARD: 40,      // 展示内容的基础阈值
  MIN_WORDS_CODE: 15,          // 代码块更快展示
  MIN_WORDS_LIST: 20,          // 列表更快展示
  MIN_WORDS_QUESTION: 8,       // AI 提问更快展示
  MIN_WORDS_HEADER: 12,        // 标题表示结构
  MIN_BUFFER_MS: 500,          // 至少等待 500ms
  MAX_BUFFER_MS: 2500,         // 缓冲不超过 2.5s
  TIMEOUT_MIN_WORDS: 5,        // 超时后至少有这么多词才展示
  HIGH_WORD_COUNT: 60,         // 达到该词数时无论结构如何都展示
  CONTENT_THROTTLE_MS: 300,    // 流式输出时内容更新节流（性能优化）
} as const

type BufferReason =
  | 'complete'
  | 'min_time'
  | 'timeout'
  | 'code_block'
  | 'list'
  | 'header'
  | 'question'
  | 'threshold_met'
  | 'high_word_count'
  | 'buffering'

/** 统计文本中的词数 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length
}

/** 检测（围栏）代码块 */
function hasCodeBlock(text: string): boolean {
  return /```/.test(text)
}

/** 检测 markdown 列表（无序或有序） */
function hasList(text: string): boolean {
  return /^\s*[-*•]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)
}

/** 检测 markdown 标题 */
function hasHeader(text: string): boolean {
  return /^#{1,4}\s/m.test(text)
}

/** 检测结构性内容（句子、段落等） */
function hasStructure(text: string): boolean {
  // 句末标点（句号、感叹号、问号、冒号）
  if (/[.!?:]\s*$/.test(text.trimEnd())) return true
  // 段落换行
  if (/\n\s*\n/.test(text)) return true
  // 任意位置的标题
  if (/\n\s*#{1,4}\s/.test(text)) return true
  // 代码块
  if (hasCodeBlock(text)) return true
  return false
}

/** 检测文本是否以问号结尾（AI 寻求澄清） */
function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text.trim())
}

/**
 * 判断缓冲内容是否应该展示。
 * 这是核心的缓冲决策函数。
 *
 * @param text - 累积的响应文本
 * @param isStreaming - 响应是否仍在流式输出
 * @param streamStartTime - 流式输出开始时间（用于超时计算）
 * @returns 决策结果及原因（便于调试）
 */
function shouldShowContent(
  text: string,
  isStreaming: boolean,
  streamStartTime?: number
): { shouldShow: boolean; reason: BufferReason; wordCount: number } {
  const wordCount = countWords(text)

  // 完整内容立即展示
  if (!isStreaming) {
    return { shouldShow: true, reason: 'complete', wordCount }
  }

  const elapsed = streamStartTime ? Date.now() - streamStartTime : 0

  // 最小缓冲时间——至少等待 500ms
  if (elapsed < BUFFER_CONFIG.MIN_BUFFER_MS) {
    return { shouldShow: false, reason: 'min_time', wordCount }
  }

  // 最大缓冲时间——2.5s 后若有内容则强制展示
  if (elapsed > BUFFER_CONFIG.MAX_BUFFER_MS && wordCount >= BUFFER_CONFIG.TIMEOUT_MIN_WORDS) {
    return { shouldShow: true, reason: 'timeout', wordCount }
  }

  // 高置信度模式获得加速处理

  // 代码块——开发者希望尽早看到代码
  if (hasCodeBlock(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_CODE) {
    return { shouldShow: true, reason: 'code_block', wordCount }
  }

  // 标题表示结构化内容
  if (hasHeader(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_HEADER) {
    return { shouldShow: true, reason: 'header', wordCount }
  }

  // 列表表示结构化内容
  if (hasList(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_LIST) {
    return { shouldShow: true, reason: 'list', wordCount }
  }

  // AI 的提问（澄清）——快速展示
  if (isQuestion(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_QUESTION) {
    return { shouldShow: true, reason: 'question', wordCount }
  }

  // 标准阈值——40 词且有一定结构
  if (wordCount >= BUFFER_CONFIG.MIN_WORDS_STANDARD && hasStructure(text)) {
    return { shouldShow: true, reason: 'threshold_met', wordCount }
  }

  // 高词数——无论结构如何都展示
  if (wordCount >= BUFFER_CONFIG.HIGH_WORD_COUNT) {
    return { shouldShow: true, reason: 'high_word_count', wordCount }
  }

  return { shouldShow: false, reason: 'buffering', wordCount }
}

/**
 * 检查响应当前是否处于缓冲状态。
 * TurnCard 用此函数展示轻微提示而非大卡片。
 */
function isResponseBuffering(response: ResponseContent | undefined): boolean {
  if (!response) return false
  if (!response.isStreaming) return false
  const decision = shouldShowContent(response.text, response.isStreaming, response.streamStartTime)
  return !decision.shouldShow
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 获取工具的展示名（去掉 MCP 前缀，应用友好名称） */
function getToolDisplayName(name: string): string {
  const stripped = name.replace(/^mcp__[^_]+__/, '')

  // 特定工具的友好展示名
  const displayNames: Record<string, string> = {
    'TodoWrite': 'Todo List Updated',
    'set_session_labels': 'Set Session Labels',
    'set_session_status': 'Set Session Status',
    'get_session_info': 'Get Session Info',
    'list_sessions': 'List Sessions',
  }

  return displayNames[stripped] || stripped
}

/**
 * 从文件路径中剥离会话/工作区文件夹路径，以便更干净地展示。
 * 仅剥离与当前会话文件夹路径匹配的前缀。
 * 示例：/path/to/sessions/260121-foo/plans/file.md → plans/file.md
 */
function stripSessionFolderPath(filePath: string, sessionFolderPath?: string): string {
  if (!sessionFolderPath) return filePath

  // 获取工作区路径（sessions 文件夹的父级）
  // sessionFolderPath: /path/workspaces/{uuid}/sessions/{sessionId}
  const workspacePath = normalizePath(sessionFolderPath).replace(/\/sessions\/[^/]+$/, '')

  // 优先尝试会话文件夹（更具体）
  if (pathStartsWith(filePath, sessionFolderPath)) {
    return stripPathPrefix(filePath, sessionFolderPath)
  }

  // 再尝试工作区文件夹
  if (pathStartsWith(filePath, workspacePath)) {
    return stripPathPrefix(filePath, workspacePath)
  }

  return filePath
}

/** 将工具输入格式化为简短摘要，溢出由 CSS truncate 处理 */
function formatToolInput(
  input?: Record<string, unknown>,
  toolName?: string,
  sessionFolderPath?: string
): string {
  if (!input || Object.keys(input).length === 0) return ''

  // 对于 call_llm：model 以徽章展示，prompt 与 intent 重复
  if (toolName === 'mcp__session__call_llm') return ''

  const parts: string[] = []

  // 对于 Edit/Write 工具，只展示 file_path（跳过 old_string、new_string、replace_all、content）
  const isEditOrWrite = toolName === 'Edit' || toolName === 'Write'

  // 处理 Codex 格式：{ changes: Array<{ path, kind, diff }> }
  // 若存在则从第一个 change 中提取 path
  if (isEditOrWrite && input.changes && Array.isArray(input.changes)) {
    const firstChange = input.changes[0] as { path?: string } | undefined
    if (firstChange?.path) {
      const pathStr = stripSessionFolderPath(firstChange.path, sessionFolderPath)
      parts.push(pathStr)
    }
    return parts.join(' ')
  }

  for (const [key, value] of Object.entries(input)) {
    // 跳过 meta 字段和 description（单独展示）
    if (key === '_intent' || key === 'description' || value === undefined || value === null) continue

    // 对于 Edit/Write 工具，只包含 file_path
    if (isEditOrWrite && key !== 'file_path') continue

    let valStr = typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim()
      : JSON.stringify(value)

    // 对 Edit/Write 工具的 file_path 剥离会话/工作区路径前缀
    if (isEditOrWrite && key === 'file_path' && typeof value === 'string') {
      valStr = stripSessionFolderPath(valStr, sessionFolderPath)
    }

    parts.push(valStr)
    if (parts.length >= 2) break // 最多 2 个值
  }
  return parts.join(' ')
}

/**
 * 从 LLM 提供的 displayName 中提取动作部分，剥离匹配的图标/工具前缀。
 *
 * 示例：
 *   extractActionFromDisplayName("Git", "Git Status")  → "Status"
 *   extractActionFromDisplayName("npm", "Install Deps") → "Install Deps"
 *   extractActionFromDisplayName("Git", "Check Branch")  → "Check Branch"
 */
function extractActionFromDisplayName(iconName: string, llmName: string): string {
  // 若 LLM 名称以图标名开头，则剥离前缀得到动作
  // "Git Status" 配图标 "Git" → "Status"
  if (llmName.toLowerCase().startsWith(iconName.toLowerCase() + ' ')) {
    return llmName.slice(iconName.length + 1).trim()
  }
  // 否则使用完整 LLM 名称作为动作
  // "Install Dependencies" 配图标 "npm" → "Install Dependencies"
  return llmName
}

/**
 * 使用嵌入的 toolDisplayMeta 格式化工具展示。
 * toolDisplayMeta 在主进程存储时写入，包含：
 * - displayName：人类可读名称
 * - iconDataUrl：base64 编码的图标（用于 skills/sources）
 * - description：简短描述
 * - category：'skill' | 'source' | 'native' | 'mcp'
 */
function formatToolDisplay(
  activity: ActivityItem
): { name: string; icon?: string; description?: string } {
  const { toolName, displayName, toolInput, toolDisplayMeta } = activity

  // 优先：使用嵌入的 toolDisplayMeta（Electron 和 viewer 都适用）
  if (toolDisplayMeta) {
    // 对于 MCP 工具，将 tool slug 追加到 source 名称后
    if (toolName?.startsWith('mcp__') && toolDisplayMeta.category === 'source') {
      const parts = toolName.match(/^mcp__([^_]+)__(.+)$/)
      if (parts) {
        const toolSlug = parts[2]
        return {
          name: `${toolDisplayMeta.displayName}: ${toolSlug}`,
          icon: toolDisplayMeta.iconDataUrl,
          description: toolDisplayMeta.description,
        }
      }
    }

    // 对于带 LLM displayName 的 Bash 命令：合并图标名 + 动作
    // 例如 图标 "Git" + LLM "Git Status" → "Git: Status"
    // 例如 图标 "npm" + LLM "Install Dependencies" → "npm: Install Dependencies"
    // 特例：对于通用 "Terminal"，只展示动作
    // 例如 图标 "Terminal" + LLM "Install Dependencies" → "Install Dependencies"
    if (toolName === 'Bash' && displayName) {
      const iconName = toolDisplayMeta.displayName
      const action = extractActionFromDisplayName(iconName, displayName)
      return {
        name: iconName.toLowerCase() === 'terminal' ? action : `${iconName}: ${action}`,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    // 对于带 LLM displayName 的原生工具：使用 LLM 的名称
    // 这样能得到语义化名称，例如 "Read Config" 而非通用 "Read"
    if (displayName && toolDisplayMeta.category === 'native') {
      return {
        name: displayName,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    return {
      name: toolDisplayMeta.displayName,
      icon: toolDisplayMeta.iconDataUrl,
      description: toolDisplayMeta.description,
    }
  }

  // 没有 toolDisplayMeta 的 Skill 工具的兜底（旧会话）
  if (toolName === 'Skill' && toolInput?.skill) {
    const skillId = String(toolInput.skill)
    // 从限定名（workspaceId:slug）中提取 slug 用于展示
    const colonIdx = skillId.indexOf(':')
    const slug = colonIdx > 0 ? skillId.slice(colonIdx + 1) : skillId
    return { name: slug }
  }

  // 最终兜底：使用 LLM 生成的 displayName 或工具名
  const name = displayName || (toolName ? getToolDisplayName(toolName) : i18n.t('turnCard.processing'))
  return { name }
}

/** 获取折叠状态下使用的主要预览文本 */
function getPreviewText(
  activities: ActivityItem[],
  intent?: string,
  isStreaming?: boolean,
  hasResponse?: boolean,
  isComplete?: boolean
): string {
  // 若有显式 intent，直接使用
  if (intent) return intent

  // 查找最相关的 activity intent
  const activityWithIntent = activities.find(a => a.intent)
  if (activityWithIntent?.intent) return activityWithIntent.intent

  // 检查是否处于响应状态
  if (isStreaming && hasResponse) return i18n.t('turnCard.responding')

  // 查找运行中的 Task 工具并展示其描述
  const runningTask = activities.find(a => isParentTaskTool(a.toolName ?? '') && a.status === 'running')
  if (runningTask?.toolInput?.description) {
    return runningTask.toolInput.description as string
  }

  // 仍在流式输出时，展示最新的中间消息内容
  // 这让用户能看到 LLM 正在"思考"什么
  if (isStreaming && !isComplete) {
    const latestIntermediate = [...activities]
      .reverse()
      .find(a => a.type === 'intermediate' && a.content)
    if (latestIntermediate?.content) {
      return latestIntermediate.content
    }
  }

  // 获取运行中和已完成的工具（不含中间消息）
  const runningTools = activities.filter(a => a.status === 'running' && a.toolName)
  const errorCount = activities.filter(a => a.status === 'error').length

  // 展示运行中的工具名
  if (runningTools.length > 0) {
    const toolNames = runningTools
      .map(a => getToolDisplayName(a.toolName!))
      .slice(0, 3) // 最多 3 个
    return `${toolNames.join(', ')}...`
  }

  // 完成时，若可用则展示第一个 Task 的描述
  const firstTask = activities.find(a => isParentTaskTool(a.toolName ?? ''))
  if (firstTask?.toolInput?.description) {
    const errorSuffix = errorCount > 0
      ? i18n.t('turnCard.errorCount', { count: errorCount })
      : ''
    return `${firstTask.toolInput.description as string}${errorSuffix}`
  }

  // 完成时，展示摘要（徽章已展示数量）
  if (isComplete || (!isStreaming && activities.length > 0)) {
    const errorSuffix = errorCount > 0
      ? i18n.t('turnCard.errorCount', { count: errorCount })
      : ''
    return `${i18n.t('turnCard.stepsCompleted')}${errorSuffix}`
  }

  return i18n.t('turnCard.starting')
}


// ============================================================================
// 子组件
// ============================================================================

/**
 * activity 的状态图标——导出供 InlineExecution 复用。
 * 完成时支持来自 skill/source 元数据的自定义图标。
 * Edit/Write 工具展示工具专属图标；其余展示勾选或自定义图标。
 */
export function ActivityStatusIcon({
  status,
  toolName,
  customIcon
}: {
  status: ActivityStatus
  toolName?: string
  /** 来自工具元数据的自定义图标——emoji 或 data URL（base64） */
  customIcon?: string
}) {
  // 根据状态渲染对应图标
  const renderIcon = () => {
    // 完成状态且有自定义图标时，用它替代勾选
    if (status === 'completed' && customIcon) {
      // 检查是否为 emoji（短字符串，非 URL 或 data URL）
      // emoji 因 ZWJ 序列可能有 1-4 个以上字符
      const isLikelyEmoji = customIcon.length <= 8 && !/^(https?:\/\/|data:)/.test(customIcon)
      if (isLikelyEmoji) {
        return (
          <span className={cn(SIZE_CONFIG.iconSize, "shrink-0 flex items-center justify-center text-[10px] leading-none")}>
            {customIcon}
          </span>
        )
      }
      // 否则是 data URL（base64）或 HTTP URL
      return (
        <img
          src={customIcon}
          alt=""
          className={cn(SIZE_CONFIG.iconSize, "shrink-0 rounded-sm object-contain")}
        />
      )
    }

    // 默认图标逻辑
    switch (status) {
      case 'pending':
        return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
      case 'running':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={SIZE_CONFIG.spinnerSize} />
          </div>
        )
      case 'backgrounded':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={cn(SIZE_CONFIG.spinnerSize, "text-accent")} />
          </div>
        )
      case 'completed':
        // Edit 和 Write 工具使用各自带 accent 色的图标，而非绿色勾选
        if (toolName === 'Edit') {
          return <Pencil className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        if (toolName === 'Write') {
          return <FilePenLine className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        return <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-success")} />
      case 'error':
        return <XCircle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-destructive")} />
    }
  }

  // 用 AnimatePresence 包裹实现状态间淡入淡出
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={status}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="shrink-0"
      >
        {renderIcon()}
      </motion.div>
    </AnimatePresence>
  )
}

interface ActivityRowProps {
  activity: ActivityItem
  /** 在 Monaco 中打开 activity 详情的回调 */
  onOpenDetails?: () => void
  /** 是否为其深度层级的最后一个子项（用于树状视图中的 └ 拐角） */
  isLastChild?: boolean
  /** 会话文件夹路径，用于在工具展示中从文件路径里剔除该前缀 */
  sessionFolderPath?: string
  /** 展示模式：'detailed' 展示全部信息，'informative' 隐藏 MCP/API 名称和参数 */
  displayMode?: 'informative' | 'detailed'
}

/**
 * TreeViewConnector 已不再使用——展开区域的竖线已提供视觉层级。
 * 暂时保留为 no-op，以备将来可能需要按深度缩进。
 */
function TreeViewConnector({ depth }: { depth: number; isLastChild?: boolean }) {
  if (depth === 0) return null

  // 仅按深度添加缩进，不画连接线
  return (
    <div className="flex self-stretch">
      {Array.from({ length: depth }).map((_, i) => (
        <div key={i} className="w-4 shrink-0" />
      ))}
    </div>
  )
}

/** 展开视图中的单个 activity 行 */
function ActivityRow({ activity, onOpenDetails, isLastChild, sessionFolderPath, displayMode = 'detailed' }: ActivityRowProps) {
  const depth = activity.depth || 0

  // 中间消息（LLM 评论）——使用虚线圆圈图标渲染
  // 流式输出时展示 "Thinking"，完成时展示剥离 markdown 后的内容
  if (activity.type === 'intermediate') {
    const isThinking = activity.status === 'running'
    const displayContent = isThinking ? 'Thinking...' : stripMarkdown(activity.content || '')
    const isComplete = activity.status === 'completed'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "group/row flex items-center gap-2 py-0.5 text-foreground/75 flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
          onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
        >
          {isThinking ? (
            <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
              <Spinner className={SIZE_CONFIG.spinnerSize} />
            </div>
          ) : (
            <MessageCircleDashed className={cn(SIZE_CONFIG.iconSize, "shrink-0")} />
          )}
          <span className={cn("truncate flex-1", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayContent}</span>
          {/* 打开详情按钮 */}
          {onOpenDetails && isComplete && (
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onOpenDetails()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  onOpenDetails()
                }
              }}
              className={cn(
                "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
                "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
            >
              <ArrowUpRight className={SIZE_CONFIG.iconSize} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // 状态 activity（例如 compacting）——系统级，使用独特样式
  if (activity.type === 'status') {
    const isRunning = activity.status === 'running'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "flex items-center gap-2 py-0.5 text-muted-foreground flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
        >
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            {isRunning ? (
              <Spinner className={SIZE_CONFIG.spinnerSizeSmall} />
            ) : (
              <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "text-success")} />
            )}
          </div>
          <span className="truncate">{activity.content}</span>
        </div>
      </div>
    )
  }

  // 工具 activity——展示状态图标
  // 格式："[展示名] · [Intent/Description] [参数]"
  // - 展示名：来自 toolDisplayMeta（嵌入消息中）、LLM 生成或兜底
  // - Intent：MCP 工具用 activity.intent，Bash 用 toolInput.description
  // - 参数：剩余工具输入摘要
  const toolDisplay = formatToolDisplay(activity)
  const fullDisplayName = toolDisplay.name
    || (activity.type === 'thinking' ? 'Thinking' : 'Processing')

  // 检测 MCP/API 工具（toolName 以 "mcp__" 开头）
  const isMcpOrApiTool = activity.toolName?.startsWith('mcp__') ?? false

  // 对于 MCP/API 工具，提取 source 名称和 tool slug
  // 例如 "ClickUp: clickup_search" -> sourceName="ClickUp", toolSlug="clickup_search"
  let sourceName = fullDisplayName
  let toolSlug: string | undefined = undefined
  if (isMcpOrApiTool) {
    const colonIndex = fullDisplayName.indexOf(':')
    if (colonIndex > 0) {
      sourceName = fullDisplayName.substring(0, colonIndex).trim()
      toolSlug = fullDisplayName.substring(colonIndex + 1).trim()
    }
  }

  // 对于非 MCP 工具或 informative 模式，使用对应的展示名
  const displayedName: string = isMcpOrApiTool ? sourceName : fullDisplayName

  // MCP 工具用 intent，Bash 命令用 description
  const intentOrDescription = activity.intent || (activity.toolInput?.description as string | undefined)
  const inputSummary = formatToolInput(activity.toolInput, activity.toolName, sessionFolderPath)
  const diffStats = computeEditWriteDiffStats(activity.toolName, activity.toolInput)
  const isComplete = activity.status === 'completed' || activity.status === 'error'
  const isBackgrounded = activity.status === 'backgrounded'

  // 后台任务展示 task/shell ID 和已用时间
  const backgroundInfo = isBackgrounded
    ? activity.taskId
      ? `Task ID: ${activity.taskId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
      : activity.shellId
        ? `Shell ID: ${activity.shellId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
        : null
    : null

  return (
    <div className="flex items-stretch">
      <TreeViewConnector depth={depth} isLastChild={isLastChild} />
      <div
        className={cn(
          "group/row flex items-center gap-2 py-0.5 text-muted-foreground flex-1 min-w-0",
          SIZE_CONFIG.fontSize
        )}
        onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
      >
        <ActivityStatusIcon status={activity.status} toolName={activity.toolName} customIcon={toolDisplay.icon} />
        {/* MCP/API 工具：Source 名称（shrink-0）→ 错误徽章（若有）→ 复合标签（flex-1） */}
        {isMcpOrApiTool && !isBackgrounded && (
          <>
            <span className="shrink-0">{sourceName}</span>
            {/* MCP/API 工具的错误徽章 */}
            {activity.status === 'error' && activity.error && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                    style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
                  >
                    {i18n.t('common.error')}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[400px]">
                  {activity.error}
                </TooltipContent>
              </Tooltip>
            )}
            {/* LLM Query 的 model 徽章 */}
            {activity.toolName === 'mcp__session__call_llm' && activity.toolInput?.model && (
              <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[10px] text-foreground/60 shrink-0">
                {String(activity.toolInput.model)}
              </span>
            )}
            {(intentOrDescription || (displayMode === 'detailed' && (toolSlug || inputSummary))) && (
              <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
                {intentOrDescription && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span>{intentOrDescription}</span>
                  </>
                )}
                {displayMode === 'detailed' && toolSlug && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-70">{toolSlug}</span>
                  </>
                )}
                {displayMode === 'detailed' && inputSummary && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-50">{inputSummary}</span>
                  </>
                )}
              </span>
            )}
          </>
        )}
        {/* 原生工具：工具名（shrink-0） */}
        {!isMcpOrApiTool && (
          <span className={cn("shrink-0", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayedName}</span>
        )}
        {/* diff 统计和文件名徽章——位于工具名之后 */}
        {!isMcpOrApiTool && !isBackgrounded && diffStats && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            {diffStats.deletions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted rounded-[4px] text-destructive"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >{diffStats.deletions}</span>
            )}
            {diffStats.additions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--success)_5%,var(--background))] shadow-tinted rounded-[4px] text-success"
                style={{ '--shadow-color': 'var(--success-rgb)' } as React.CSSProperties}
              >{diffStats.additions}</span>
            )}
            {/* 文件名徽章——兼容 Claude Code 和 Codex 两种格式 */}
            {(() => {
              // Claude Code 格式：file_path
              if (typeof activity.toolInput?.file_path === 'string') {
                return (
                  <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                    {normalizePath(activity.toolInput.file_path).split('/').pop()}
                  </span>
                )
              }
              // Codex 格式：changes[0].path
              if (Array.isArray(activity.toolInput?.changes)) {
                const firstChange = activity.toolInput.changes[0] as { path?: string } | undefined
                if (firstChange?.path) {
                  return (
                    <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                      {normalizePath(firstChange.path).split('/').pop()}
                    </span>
                  )
                }
              }
              return null
            })()}
          </span>
        )}
        {/* Read 工具的文件名徽章（无 diff 统计） */}
        {!isMcpOrApiTool && !isBackgrounded && !diffStats && activity.toolName === 'Read' && typeof activity.toolInput?.file_path === 'string' && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
              {normalizePath(activity.toolInput.file_path).split('/').pop()}
            </span>
          </span>
        )}
        {/* 原生工具的错误徽章 */}
        {!isMcpOrApiTool && activity.status === 'error' && activity.error && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >
                Error
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[400px]">
              {activity.error}
            </TooltipContent>
          </Tooltip>
        )}
        {/* 原生工具：带 description + params 的复合标签（flex-1） */}
        {/* informative 模式下隐藏 inputSummary（命令详情），只展示 description */}
        {!isMcpOrApiTool && !isBackgrounded && (intentOrDescription || (displayMode === 'detailed' && inputSummary)) && (
          <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
            {intentOrDescription && (
              <>
                <span className="opacity-60"> · </span>
                <span>{intentOrDescription}</span>
              </>
            )}
            {displayMode === 'detailed' && inputSummary && (
              <>
                <span className="opacity-60"> · </span>
                <span className="opacity-50">{inputSummary}</span>
              </>
            )}
          </span>
        )}
        {/* 后台任务信息（task/shell ID + 已用时间） */}
        {backgroundInfo && (
          <>
            <span className="opacity-60 shrink-0">·</span>
            <span className="truncate min-w-0 max-w-[300px] text-accent">{backgroundInfo}</span>
          </>
        )}
        {/* 无需 spacer——MCP/API 和原生工具的复合 span 都已有 flex-1 */}
        {/* 打开详情按钮 */}
        {onOpenDetails && isComplete && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onOpenDetails()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenDetails()
              }
            }}
            className={cn(
              "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
              "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            <ArrowUpRight className={SIZE_CONFIG.iconSize} />
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Activity Group 组件（用于 Task 子代理）
// ============================================================================

interface ActivityGroupRowProps {
  group: ActivityGroup
  /** activity 分组的受控展开状态 */
  expandedGroups?: Set<string>
  /** 展开状态变化时的回调 */
  onExpandedGroupsChange?: (groups: Set<string>) => void
  /** 在 Monaco 中打开 activity 详情的回调 */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** 交错动画的索引 */
  animationIndex?: number
  /** 会话文件夹路径，用于在工具展示中从文件路径里剔除该前缀 */
  sessionFolderPath?: string
  /** 展示模式：'detailed' 展示全部信息，'informative' 隐藏 MCP/API 名称和参数 */
  displayMode?: 'informative' | 'detailed'
}

/**
 * 渲染一个 Task 子代理及其子 activity 分组。
 * 提供视觉上的包含关系和可折叠子项。
 */
function ActivityGroupRow({ group, expandedGroups: externalExpandedGroups, onExpandedGroupsChange, onOpenActivityDetails, animationIndex = 0, sessionFolderPath, displayMode = 'detailed' }: ActivityGroupRowProps) {
  // 若未提供受控状态则使用本地状态
  const [localExpandedGroups, setLocalExpandedGroups] = useState<Set<string>>(new Set())
  const expandedGroups = externalExpandedGroups ?? localExpandedGroups
  const setExpandedGroups = onExpandedGroupsChange ?? setLocalExpandedGroups

  const groupId = group.parent.id
  const isExpanded = expandedGroups.has(groupId)

  const toggleExpanded = useCallback(() => {
    const next = new Set(expandedGroups)
    if (next.has(groupId)) {
      next.delete(groupId)
    } else {
      next.add(groupId)
    }
    setExpandedGroups(next)
  }, [groupId, expandedGroups, setExpandedGroups])

  const description = group.parent.toolInput?.description as string | undefined
  const subagentType = group.parent.toolInput?.subagent_type as string | undefined
  const isComplete = group.parent.status === 'completed' || group.parent.status === 'error'
  const hasError = group.parent.status === 'error'

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: animationIndex < SIZE_CONFIG.staggeredAnimationLimit ? animationIndex * 0.03 : 0.3 }}
      className="space-y-0.5"
    >
      {/* Task 头部行——无左内边距，chevron 与 activity 行图标对齐 */}
      <div
        className={cn(
          "group/row flex items-center gap-2 py-0.5 rounded-md cursor-pointer text-muted-foreground",
          "hover:text-foreground transition-colors",
          SIZE_CONFIG.fontSize
        )}
        onClick={toggleExpanded}
      >
        {/* 展开/折叠 chevron——与 activity 行图标对齐 */}
        <motion.div
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
        >
          <ChevronRight className={SIZE_CONFIG.iconSize} />
        </motion.div>

        {/* 状态图标——与工具调用图标对齐 */}
        <ActivityStatusIcon status={group.parent.status} toolName={group.parent.toolName} />

        {/* 子代理类型徽章 */}
        <span className="shrink-0 px-1.5 py-0.5 rounded-[4px] bg-background shadow-minimal text-[10px] font-medium">
          {subagentType || 'Task'}
        </span>

        {/* Task 描述或兜底文案 */}
        <span className={cn(
          "truncate",
          hasError && "text-destructive"
        )}>
          {description || 'Task'}
        </span>

        {/* 来自 TaskOutput 的耗时和 token 统计（仅完成时展示） */}
        {isComplete && group.taskOutputData && (
          <span className="shrink-0 text-muted-foreground/60 tabular-nums">
            {group.taskOutputData.durationMs !== undefined && (
              <span>{formatDuration(group.taskOutputData.durationMs)}</span>
            )}
            {group.taskOutputData.durationMs !== undefined &&
              (group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span className="mx-1">·</span>
            )}
            {(group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span>
                {formatTokens((group.taskOutputData.inputTokens || 0) + (group.taskOutputData.outputTokens || 0))} tokens
              </span>
            )}
          </span>
        )}

        {/* spacer，将详情按钮推到右侧 */}
        <span className="flex-1" />

        {/* Task 本身的打开详情按钮 */}
        {onOpenActivityDetails && isComplete && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onOpenActivityDetails(group.parent)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenActivityDetails(group.parent)
              }
            }}
            className={cn(
              "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
              "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            <ArrowUpRight className={SIZE_CONFIG.iconSize} />
          </div>
        )}
      </div>

      {/* 带缩进的子项 */}
      <AnimatePresence initial={false}>
        {isExpanded && group.children.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
              opacity: { duration: 0.15 }
            }}
            className="overflow-hidden"
          >
            <div className="pl-0 space-y-0.5 border-l-2 border-muted ml-[5px]">
              {group.children.map((child, idx) => (
                <motion.div
                  key={child.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.02 }}
                  className="ml-[-4px]"
                >
                  <ActivityRow
                    activity={child}
                    onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(child) : undefined}
                    isLastChild={idx === group.children.length - 1}
                    sessionFolderPath={sessionFolderPath}
                    displayMode={displayMode}
                  />
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ============================================================================
// 流式响应预览组件
// ============================================================================

export interface ResponseCardProps {
  /** 要展示的内容（markdown） */
  text: string
  /** 内容是否仍在流式输出 */
  isStreaming: boolean
  /** 流式输出开始时间——用于缓冲超时计算 */
  streamStartTime?: number
  /** 在编辑器中打开文件的回调 */
  onOpenFile?: (path: string) => void
  /** 打开 URL 的回调 */
  onOpenUrl?: (url: string) => void
  /** 在 Monaco 编辑器中打开响应的回调 */
  onPopOut?: () => void
  /** 卡片变体——'response' 用于 AI 消息，'plan' 用于 plan 消息 */
  variant?: 'response' | 'plan'
  /** 父会话 ID（用于会话切换时重置本地批注/island UI 状态） */
  sessionId?: string
  /** 批注操作使用的底层消息 ID */
  messageId?: string
  /** 该响应的持久化批注 */
  annotations?: AnnotationV1[]
  /** 用户接受计划时的回调（仅 plan 变体） */
  onAccept?: () => void
  /** 用户"接受并 Compact"时的回调（先 compact 再执行） */
  onAcceptWithCompact?: () => void
  /** 是否为会话中最后一条响应（仅最后一条响应展示 Accept Plan 按钮） */
  isLastResponse?: boolean
  /** 是否展示 Accept Plan 按钮（默认 true） */
  showAcceptPlan?: boolean
  /** compact 页脚布局。隐藏响应页脚中的 Copy / Markdown / Branch；
   *  当 plan 是最后一条响应时保留 Accept Plan 下拉菜单。 */
  compactMode?: boolean
  /** 从该响应分支会话的回调 */
  onBranch?: (options?: { newPanel?: boolean }) => void
  /** 从选中文本添加批注的回调 */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** 移除持久化批注的回调 */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** 更新持久化批注的回调 */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** follow-up 编辑器使用的发送键行为 */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** 通过"Save & Send"保存 follow-up 时的回调 */
  onSaveAndSendFollowUp?: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  /** 会话中是否存在活跃的 pending follow-up 批注 */
  hasActiveFollowUpAnnotations?: boolean
  /** 在该响应中打开指定批注的外部请求 */
  openAnnotationRequest?: OpenAnnotationRequest | null
  /** 批注交互模式（viewer 使用 tooltip-only 以抑制 island） */
  annotationInteractionMode?: AnnotationInteractionMode
}

interface BranchDropdownProps {
  onBranch: (options?: { newPanel?: boolean }) => void
}

function BranchDropdown({ onBranch }: BranchDropdownProps) {
  const { t } = useTranslation()
  const handleBranchClick = () => {
    onBranch({ newPanel: true })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('chat.branchOptions')}
          title={t('chat.branch')}
          className={cn(
            "p-1 rounded-[4px] transition-colors select-none",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
            "data-[state=open]:text-foreground data-[state=open]:bg-foreground/5",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          <GitBranch className={SIZE_CONFIG.iconSize} />
        </button>
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" minWidth="min-w-64" sideOffset={6}>
        <StyledDropdownMenuItem onClick={handleBranchClick} className="items-start py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] leading-tight">{t('chat.branchFromThisMessage')}</span>
            <span className="max-w-[220px] whitespace-normal text-xs leading-tight text-muted-foreground">
              {t('chat.branchFromThisMessageDescription')}
            </span>
          </div>
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

const MAX_HEIGHT = 540

function clearAnnotationMarks(root: HTMLElement): void {
  const annotatedInlineCodeNodes = root.querySelectorAll<HTMLElement>('code[data-ca-annotation-inline-code="true"]')
  annotatedInlineCodeNodes.forEach((codeNode) => {
    codeNode.removeAttribute('data-ca-annotation-inline-code')
    codeNode.style.backgroundColor = ''
    codeNode.style.boxShadow = ''
  })

  const marks = root.querySelectorAll('span[data-ca-annotation-id]')
  marks.forEach(mark => {
    const parent = mark.parentNode
    if (!parent) return

    const badge = mark.querySelector('[data-ca-annotation-index]')
    if (badge) badge.remove()

    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
    parent.normalize()
  })
}

function createAnnotationIndexBadge(index: number): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.setAttribute('data-ca-annotation-index', String(index))
  chip.textContent = String(index)
  chip.style.position = 'absolute'
  chip.style.top = '-7px'
  chip.style.right = '-7px'
  chip.style.minWidth = '16px'
  chip.style.height = '15px'
  chip.style.padding = '0 3px'
  chip.style.borderRadius = '9999px'
  chip.style.backgroundColor = 'var(--info)'
  chip.style.color = 'rgba(15, 23, 42, 0.95)'
  chip.style.fontSize = '10px'
  chip.style.fontWeight = '600'
  chip.style.lineHeight = '15px'
  chip.style.textAlign = 'center'
  chip.classList.add('shadow-tinted')
  chip.style.setProperty('--shadow-color', 'var(--info-rgb)')
  chip.style.pointerEvents = 'none'
  chip.style.userSelect = 'none'
  return chip
}

function applyTextHighlightRange(
  root: HTMLElement,
  range: { start: number; end: number },
  annotation: AnnotationV1,
  annotationIndex?: number,
): void {
  if (range.end <= range.start) return

  // 避免对行首/行尾的硬换行做视觉高亮。
  // 这些换行可能产生额外的视觉空行。
  const fullText = getCanonicalText(root)
  let displayStart = range.start
  let displayEnd = range.end
  while (displayStart < displayEnd && /[\n\r]/.test(fullText[displayStart] ?? '')) displayStart += 1
  while (displayEnd > displayStart && /[\n\r]/.test(fullText[displayEnd - 1] ?? '')) displayEnd -= 1
  if (displayEnd <= displayStart) return

  const segments = collectTextSegments(root)
  const createdMarks: HTMLSpanElement[] = []

  for (const segment of segments) {
    if (segment.end <= displayStart || segment.start >= displayEnd) continue

    const localStart = Math.max(displayStart, segment.start) - segment.start
    const localEnd = Math.min(displayEnd, segment.end) - segment.start
    if (localEnd <= localStart) continue

    const source = segment.node
    const after = source.splitText(localEnd)
    const selected = source.splitText(localStart)

    const inlineCodeParent = selected.parentElement?.closest<HTMLElement>('code')
    if (inlineCodeParent) {
      inlineCodeParent.setAttribute('data-ca-annotation-inline-code', 'true')
      inlineCodeParent.style.backgroundColor = annotationColorToCss(annotation.style?.color)
      inlineCodeParent.style.boxShadow = 'none'
    }

    const mark = document.createElement('span')
    mark.setAttribute('data-ca-annotation-id', annotation.id)
    mark.style.backgroundColor = annotationColorToCss(annotation.style?.color)
    mark.style.borderRadius = '0'
    mark.style.padding = '0'
    mark.style.margin = '0'
    mark.style.position = 'relative'
    selected.parentNode?.replaceChild(mark, selected)
    mark.appendChild(selected)
    createdMarks.push(mark)

    // 保留引用，供 TS 检查与清晰性
    void after
  }

  if (createdMarks.length > 0) {
    type RowBucket = { top: number; marks: HTMLSpanElement[] }
    const rows: RowBucket[] = []

    for (const mark of createdMarks) {
      const rect = mark.getBoundingClientRect()
      const row = rows.find(candidate => Math.abs(candidate.top - rect.top) <= 2)
      if (row) {
        row.marks.push(mark)
      } else {
        rows.push({ top: rect.top, marks: [mark] })
      }
    }

    for (const row of rows) {
      const rowMarks = row.marks
      const first = rowMarks[0]
      const last = rowMarks[rowMarks.length - 1]
      if (!first || !last) continue

      first.style.borderTopLeftRadius = '6px'
      first.style.borderBottomLeftRadius = '6px'
      last.style.borderTopRightRadius = '6px'
      last.style.borderBottomRightRadius = '6px'
    }
  }

  if (annotationIndex != null && createdMarks.length > 0) {
    // 优先将索引徽章放在非代码 mark 上，然后选择首个可见行上最靠右的 mark
    // 以获得稳定的放置位置。
    const nonCodeMarks = createdMarks.filter(mark => !mark.closest('code'))
    const badgePool = nonCodeMarks.length > 0 ? nonCodeMarks : createdMarks

    const preferredInitial = badgePool[0]
    if (!preferredInitial) return

    let preferredMark = preferredInitial
    let preferredRect = preferredMark.getBoundingClientRect()

    for (const mark of badgePool.slice(1)) {
      const rect = mark.getBoundingClientRect()
      const isHigherRow = rect.top < preferredRect.top - 1
      const sameRow = Math.abs(rect.top - preferredRect.top) <= 2
      const isMoreRight = rect.right > preferredRect.right

      if (isHigherRow || (sameRow && isMoreRight)) {
        preferredMark = mark
        preferredRect = rect
      }
    }

    preferredMark.appendChild(createAnnotationIndexBadge(annotationIndex))
  }
}

/**
 * ResponseCard - AI 响应和 plan 的统一卡片组件
 *
 * 变体：
 * - 'response'：带智能内容门控的缓冲流式响应
 * - 'plan'：带头部和 Accept Plan 按钮的 plan 消息
 *
 * response 变体实现智能缓冲：
 * - 等待 40+ 词且有结构，或
 * - 高置信度模式（代码块、标题、列表）以更低阈值，或
 * - 2.5 秒后超时
 *
 * 性能优化：使用节流的静态快照而非每个字符都重渲染。
 * 流式输出时内容每 300ms 更新一次，避免对每个 delta 做昂贵的 markdown 解析。
 */
export function ResponseCard({
  text,
  isStreaming,
  streamStartTime,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  variant = 'response',
  sessionId,
  messageId,
  annotations,
  onAccept,
  onAcceptWithCompact,
  isLastResponse = true,
  showAcceptPlan = true,
  compactMode = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
}: ResponseCardProps) {
  const { t } = useTranslation()
  // 节流后的展示内容——流式输出时每 CONTENT_THROTTLE_MS 更新一次
  const [displayedText, setDisplayedText] = useState(text)
  const lastUpdateRef = useRef(Date.now())
  // 复制到剪贴板状态
  const [copied, setCopied] = useState(false)
  // 全屏状态
  const [isFullscreen, setIsFullscreen] = useState(false)
  // 暗色模式检测——滚动渐变仅在暗色模式下展示
  const [isDarkMode, setIsDarkMode] = useState(false)
  // 等待显式 follow-up 操作的 pending 文本选区
  const interaction = useAnnotationInteractionController()
  const {
    state: interactionState,
    setDraft: setFollowUpDraft,
    openFromSelection,
    openFollowUpFromSelection,
    openFromAnnotation,
    requestEdit,
    cancelFollowUp,
    closeAll,
    markSubmitSuccess,
    markDeleteSuccess,
    consumeExternalOpenRequest,
  } = interaction

  const pendingSelection = interactionState.pendingSelection
  const selectionMenuView = interactionState.selectionMenuView
  const followUpDraft = interactionState.followUpDraft
  const followUpMode = interactionState.followUpMode
  const activeAnnotationDetail = interactionState.activeAnnotationDetail

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )
  const [annotationOverlay, setAnnotationOverlay] = useState<{ rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[] }>({ rects: [], chips: [] })
  const contentRef = useRef<HTMLDivElement>(null)
  const contentLayerRef = useRef<HTMLDivElement>(null)
  const lastPointerRef = useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = useRef<PointerSnapshot | null>(null)
  const selectionStartedInContentRef = useRef(false)

  const canAnnotate = canAnnotateMessage({
    hasAddAnnotationHandler: !!onAddAnnotation,
    hasMessageId: !!messageId,
    isStreaming,
  })
  const allowAnnotationIsland = annotationInteractionMode === 'interactive'

  // 从 document class 检测暗色模式并监听变化
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDarkMode(document.documentElement.classList.contains('dark'))
    }
    checkDarkMode()

    // 监听 documentElement 的 class 变化以响应主题切换
    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const closeSelectionMenu = useCallback(() => {
    closeAll()
  }, [closeAll])

  const isTargetInsideAnnotationIsland = useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

  const triggerSelectionMenuEntryReplay = useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

  const activeMenuAnchor = useMemo(() => {
    return getAnnotationInteractionAnchor(interactionState)
  }, [interactionState])

  const selectionMenuSourceKey = useMemo(() => {
    const messageScope = messageId ?? 'no-message'
    return getAnnotationInteractionSourceKey(interactionState, messageScope)
  }, [interactionState, messageId])

  const {
    renderAnchor: selectionMenuRenderAnchor,
    renderSourceKey: selectionMenuRenderSourceKey,
    isVisible: isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    handleExitComplete: handleSelectionMenuExitComplete,
    resetPresentation,
  } = useAnnotationIslandPresentation({
    anchor: activeMenuAnchor,
    sourceKey: selectionMenuSourceKey,
  })

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [text])

  const renderedAnnotations = useMemo(() => {
    const persisted = annotations ?? []

    if (!pendingSelection || selectionMenuView !== 'confirm-follow-up' || !messageId) {
      return persisted
    }

    if (hasExistingTextRangeAnnotation(persisted, pendingSelection.start, pendingSelection.end)) {
      return persisted
    }

    return [
      ...persisted,
      createSelectionPreviewAnnotation(messageId, pendingSelection, sessionId ?? ''),
    ]
  }, [annotations, pendingSelection, selectionMenuView, messageId])

  const activeAnnotation = useMemo(() => {
    if (!activeAnnotationDetail) return null
    return (annotations ?? []).find(annotation => annotation.id === activeAnnotationDetail.annotationId) ?? null
  }, [annotations, activeAnnotationDetail])

  useEffect(() => {
    if (!activeAnnotationDetail) return
    if (!activeAnnotation) {
      closeSelectionMenu()
    }
  }, [activeAnnotationDetail, activeAnnotation, closeSelectionMenu])

  useEffect(() => {
    const root = contentLayerRef.current
    if (!root) {
      setAnnotationOverlay({ rects: [], chips: [] })
      return
    }

    const computeGeometry = () => {
      if (!renderedAnnotations.length) return { rects: [], chips: [] }
      const geometry = computeAnnotationOverlayGeometry({
        root,
        renderedAnnotations,
        persistedAnnotations: annotations,
      })
      if (process.env.NODE_ENV !== 'production' && geometry.unresolved.length > 0) {
        console.debug('[annotations] unresolved annotations', {
          count: geometry.unresolved.length,
          ids: geometry.unresolved.map(item => item.annotation.id),
          reasons: geometry.unresolved.map(item => item.reason),
        })
      }
      return { rects: geometry.rects, chips: geometry.chips }
    }

    // 完整重算：重写 block-marker DOM。用于内容/批注变化。
    const recomputeOverlay = () => {
      clearAnnotationMarks(root)
      clearBlockAnnotationMarkers(root)

      if (!renderedAnnotations.length) {
        setAnnotationOverlay({ rects: [], chips: [] })
        return
      }

      const next = computeGeometry()
      for (const annotation of renderedAnnotations) {
        applyBlockAnnotationMarker(root, annotation)
      }
      setAnnotationOverlay(next)
    }

    // 快速路径：仅更新坐标，不修改 DOM。用于 scroll/resize。
    const recomputeOverlayCoords = () => {
      if (!renderedAnnotations.length) return
      setAnnotationOverlay(computeGeometry())
    }

    let rafId: number | null = null
    const scheduleCoordsRecompute = () => {
      if (rafId != null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        recomputeOverlayCoords()
      })
    }

    recomputeOverlay()
    window.addEventListener('resize', scheduleCoordsRecompute)
    // capture 阶段：scroll 事件不冒泡，但 capture 阶段的监听器在祖先节点上
    // 会对后代滚动触发——因此这能捕获 MarkdownDocBlock 内部的 overflow-auto
    // 视口（以及将来任何嵌套的滚动面）。
    root.addEventListener('scroll', scheduleCoordsRecompute, { capture: true, passive: true })
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', scheduleCoordsRecompute)
      root.removeEventListener('scroll', scheduleCoordsRecompute, { capture: true } as EventListenerOptions)
    }
  }, [annotations, renderedAnnotations, text, displayedText, isStreaming])

  useEffect(() => {
    if (!canAnnotate) {
      closeSelectionMenu()
    }
  }, [canAnnotate, closeSelectionMenu])

  useEffect(() => {
    // 会话切换时应完全重置本地 island UI 状态，避免旧的"热"实例
    // 抑制新聚焦会话中的进入动画。
    closeSelectionMenu()
    resetPresentation()
    dragStartPointerRef.current = null
    lastPointerRef.current = null
  }, [sessionId, closeSelectionMenu, resetPresentation])

  useEffect(() => {
    if (!hasAnnotationInteraction(interactionState) || !isSelectionMenuVisible) return

    const handleSelectionChange = () => {
      if (Date.now() - selectionMenuOpenedAtRef.current < 180) {
        return
      }

      const root = contentLayerRef.current
      if (!root) {
        closeSelectionMenu()
        return
      }

      const selection = window.getSelection()
      // 如果选区是渲染更新过程中被程序清空的，保持 island 打开。
      // 这发生在流式输出/DOM 协调期间，不应导致 follow-up UI 被关闭。
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }

      const range = selection.getRangeAt(0)
      const common = range.commonAncestorContainer
      const commonElement = common.nodeType === Node.ELEMENT_NODE
        ? common as Element
        : common.parentElement

      // 在 island 内部选中文本（例如 follow-up textarea）不应关闭它。
      if (commonElement && isTargetInsideAnnotationIsland(commonElement)) {
        return
      }

      if (!root.contains(common)) {
        closeSelectionMenu()
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [interactionState, isSelectionMenuVisible, closeSelectionMenu, isTargetInsideAnnotationIsland, selectionMenuOpenedAtRef])

  const handleOpenFollowUpView = useCallback(() => {
    if (!pendingSelection) return

    // 浏览器原生选区会抢占 follow-up textarea 的输入焦点。
    // 在 pendingSelection 中保留语义选区，仅清除 DOM 选区。
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])

  const handleRequestFollowUpEdit = useCallback(() => {
    requestEdit()
  }, [requestEdit])

  const saveFollowUp = useCallback(async (note: string): Promise<{
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  } | null> => {
    const normalizedNote = note.trim()

    if (!messageId) return null

    if (activeAnnotationDetail) {
      if (!onUpdateAnnotation || !activeAnnotation) {
        closeSelectionMenu()
        return null
      }

      const existingOtherBodies = activeAnnotation.body.filter(body => body.type !== 'highlight' && body.type !== 'note')
      const nextBody: AnnotationV1['body'] = [
        { type: 'highlight' },
        ...(normalizedNote.length > 0 ? [{ type: 'note', text: normalizedNote, format: 'plain' } as const] : []),
        ...existingOtherBodies,
      ]

      const nextMeta = { ...(activeAnnotation.meta ?? {}) }
      delete nextMeta.followUp

      try {
        await Promise.resolve(onUpdateAnnotation(messageId, activeAnnotationDetail.annotationId, {
          body: nextBody,
          intent: normalizedNote.length > 0 ? 'comment' : 'highlight',
          updatedAt: Date.now(),
          meta: normalizedNote.length > 0
            ? {
                ...nextMeta,
                followUp: {
                  text: normalizedNote,
                  updatedAt: Date.now(),
                },
              }
            : (Object.keys(nextMeta).length > 0 ? nextMeta : undefined),
        }))
      } catch {
        return null
      }

      markSubmitSuccess()

      if (normalizedNote.length === 0) return null

      return {
        messageId,
        annotationId: activeAnnotationDetail.annotationId,
        note: normalizedNote,
        selectedText: extractAnnotationSelectedText(activeAnnotation, text),
      }
    }

    if (!onAddAnnotation || !pendingSelection) return null

    if (hasExistingTextRangeAnnotation(annotations, pendingSelection.start, pendingSelection.end)) {
      closeSelectionMenu()
      return null
    }

    const annotation = createTextSelectionAnnotation(messageId, pendingSelection, normalizedNote, sessionId ?? '')

    try {
      await Promise.resolve(onAddAnnotation(messageId, annotation))
    } catch {
      return null
    }

    markSubmitSuccess()
    clearDomSelection()

    if (normalizedNote.length === 0) return null

    return {
      messageId,
      annotationId: annotation.id,
      note: normalizedNote,
      selectedText: pendingSelection.selectedText,
    }
  }, [
    messageId,
    activeAnnotationDetail,
    activeAnnotation,
    onUpdateAnnotation,
    onAddAnnotation,
    pendingSelection,
    annotations,
    closeSelectionMenu,
    sessionId,
    markSubmitSuccess,
    text,
  ])

  const handleSubmitFollowUp = useCallback((note: string) => {
    void saveFollowUp(note)
  }, [saveFollowUp])

  const handleSubmitAndSendFollowUp = useCallback((note: string) => {
    void saveFollowUp(note).then((savedFollowUp) => {
      if (!savedFollowUp) return
      onSaveAndSendFollowUp?.(savedFollowUp)
    })
  }, [saveFollowUp, onSaveAndSendFollowUp])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: contentLayerRef,
    cancelFollowUp,
  })

  const handleOpenAnnotationDetail = useCallback((
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: AnnotationIslandMode = 'view'
  ) => {
    if (!allowAnnotationIsland) return

    const annotation = (annotations ?? []).find(item => item.id === annotationId)
    const noteText = annotation ? getAnnotationNoteText(annotation) : ''

    const transition = buildAnnotationChipEntryTransition()

    setSelectionMenuTransitionConfig(transition)
    triggerSelectionMenuEntryReplay()
    openFromAnnotation({ annotationId, index, anchorX, anchorY }, noteText, mode)
  }, [allowAnnotationIsland, annotations, triggerSelectionMenuEntryReplay, openFromAnnotation])

  useEffect(() => {
    if (!allowAnnotationIsland) return

    const contentRect = contentLayerRef.current?.getBoundingClientRect()
    const fallbackAnchor = {
      x: contentRect ? contentRect.left + contentRect.width / 2 : window.innerWidth / 2,
      y: contentRect ? contentRect.top + 20 : Math.max(24, window.innerHeight * 0.2),
    }

    const consumed = consumeExternalOpenRequest(openAnnotationRequest, {
      messageId,
      annotations,
      getNoteText: getAnnotationNoteText,
      fallbackAnchor,
    })

    if (!consumed) return

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
  }, [
    allowAnnotationIsland,
    openAnnotationRequest,
    messageId,
    annotations,
    consumeExternalOpenRequest,
    triggerSelectionMenuEntryReplay,
  ])

  const handleDeleteActiveAnnotation = useCallback(() => {
    if (!onRemoveAnnotation || !messageId || !activeAnnotationDetail) return

    onRemoveAnnotation(messageId, activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, messageId, activeAnnotationDetail, markDeleteSuccess])

  const handleSelectionPointerDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    selectionStartedInContentRef.current = true
    const snapshot = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }

    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

  const showSelectionMenuFromCurrentSelection = useCallback(() => {
    const root = contentLayerRef.current
    if (!root) return

    requestAnimationFrame(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        closeSelectionMenu()
        return
      }

      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        closeSelectionMenu()
        return
      }

      const start = resolveNodeOffset(root, range.startContainer, range.startOffset)
      const end = resolveNodeOffset(root, range.endContainer, range.endOffset)
      if (start == null || end == null || end <= start) {
        closeSelectionMenu()
        return
      }

      const selectedText = range.toString()
      if (!selectedText || !/\S/.test(selectedText)) {
        closeSelectionMenu()
        return
      }

      if (hasExistingTextRangeAnnotation(annotations, start, end)) {
        closeSelectionMenu()
        return
      }

      const fullText = getCanonicalText(root)
      const prefix = fullText.slice(Math.max(0, start - ANNOTATION_PREFIX_SUFFIX_WINDOW), start)
      const suffix = fullText.slice(end, end + ANNOTATION_PREFIX_SUFFIX_WINDOW)

      // 优先使用分散的 client rects 而非 union bounds 来处理换行选区。
      // union rect 经常产生脱节的 x 轴锚点。
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.ts) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null
      const pointerY = hasRecentPointer && pointer ? pointer.y : null

      let anchorRect: DOMRect
      if (rects.length > 0) {
        if (pointerY != null) {
          const rowCandidates = rects.filter(rect => pointerY >= rect.top && pointerY <= rect.bottom)

          if (rowCandidates.length > 0) {
            if (pointerX != null) {
              const xContaining = rowCandidates.filter(rect => pointerX >= rect.left && pointerX <= rect.right)
              if (xContaining.length > 0) {
                anchorRect = xContaining.reduce((best, rect) => (rect.width > best.width ? rect : best))
              } else {
                anchorRect = rowCandidates.reduce((best, rect) => {
                  const bestDistance = Math.min(Math.abs(pointerX - best.left), Math.abs(pointerX - best.right))
                  const rectDistance = Math.min(Math.abs(pointerX - rect.left), Math.abs(pointerX - rect.right))
                  return rectDistance < bestDistance ? rect : best
                })
              }
            } else {
              anchorRect = rowCandidates.reduce((best, rect) => (rect.width > best.width ? rect : best))
            }
          } else {
            anchorRect = rects.reduce((best, rect) => {
              const bestDistance = Math.abs((best.top + best.bottom) / 2 - pointerY)
              const rectDistance = Math.abs((rect.top + rect.bottom) / 2 - pointerY)
              return rectDistance < bestDistance ? rect : best
            })
          }
        } else {
          anchorRect = rects.reduce((best, rect) => (rect.top < best.top ? rect : best))
        }
      } else {
        anchorRect = range.getBoundingClientRect()
      }

      const anchorRowRects = rects.length > 0
        ? rects.filter(rect => Math.abs(rect.top - anchorRect.top) <= 2)
        : []
      const clampRects = anchorRowRects.length > 0 ? anchorRowRects : (rects.length > 0 ? rects : [anchorRect])

      const selectionMinX = Math.min(...clampRects.map(rect => rect.left))
      const selectionMaxX = Math.max(...clampRects.map(rect => rect.right))

      // 优先使用鼠标释放位置，但限制在所选锚点行内，
      // 使多行选区仍附着在该行的实际文本上。
      const anchorX = pointerX != null
        ? clamp(pointerX, selectionMinX, selectionMaxX)
        : (anchorRect.left + (anchorRect.width / 2))
      const anchorY = anchorRect.top - 8

      const transition = buildSelectionEntryTransition(dragStartPointerRef.current, pointer)

      setSelectionMenuTransitionConfig(transition)
      triggerSelectionMenuEntryReplay()
      openFromSelection({
        start,
        end,
        selectedText,
        prefix,
        suffix,
        anchorX,
        anchorY,
      })
      dragStartPointerRef.current = null
    })
  }, [annotations, closeSelectionMenu, triggerSelectionMenuEntryReplay, openFromSelection])

  const handleTextSelection = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate || !onAddAnnotation || !messageId) return
    const root = contentLayerRef.current
    if (!root) return

    if (shouldIgnoreSelectionMouseUpTarget(event.target)) {
      selectionStartedInContentRef.current = false
      return
    }

    // mouseup 位置反映用户对弹出框锚定的最终意图。
    lastPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }

    // 块级批注手势：Shift+点击 block wrapper
    if (event.shiftKey) {
      const targetElement = event.target instanceof Element ? event.target : null
      const blockElement = targetElement?.closest<HTMLElement>('[data-ca-block-path]')
      if (blockElement) {
        const blockPath = blockElement.getAttribute('data-ca-block-path') || ''
        const blockType = blockElement.getAttribute('data-ca-block-type') || 'paragraph'
        const blockId = blockElement.getAttribute('data-ca-block-id') || undefined

        if (blockPath) {
          const alreadyExists = (annotations ?? []).some(annotation => {
            const blockSelector = annotation.target.selectors.find(s => s.type === 'block') as Extract<
              AnnotationV1['target']['selectors'][number],
              { type: 'block' }
            > | undefined
            if (!blockSelector) return false
            if (blockId && blockSelector.blockId) return blockSelector.blockId === blockId
            return blockSelector.path === blockPath
          })

          if (!alreadyExists) {
            const annotation: AnnotationV1 = {
              id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              schemaVersion: 1,
              createdAt: Date.now(),
              intent: 'highlight',
              body: [{ type: 'highlight' }],
              target: {
                source: {
                  sessionId: '',
                  messageId,
                },
                selectors: [
                  {
                    type: 'block',
                    blockType: blockType as Extract<AnnotationV1['target']['selectors'][number], { type: 'block' }>['blockType'],
                    path: blockPath,
                    ...(blockId ? { blockId } : {}),
                  },
                ],
              },
              style: { color: 'yellow' },
            }
            onAddAnnotation(messageId, annotation)
          }
        }
      }
      selectionStartedInContentRef.current = false
      closeSelectionMenu()
      return
    }

    selectionStartedInContentRef.current = false
    showSelectionMenuFromCurrentSelection()
  }, [canAnnotate, onAddAnnotation, messageId, annotations, showSelectionMenuFromCurrentSelection, closeSelectionMenu])

  useEffect(() => {
    if (!canAnnotate || !onAddAnnotation || !messageId) return

    const handleDocumentMouseUp = (event: MouseEvent) => {
      if (!selectionStartedInContentRef.current) return
      selectionStartedInContentRef.current = false

      // mouseup 位置反映用户对弹出框锚定的最终意图。
      lastPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        ts: Date.now(),
      }

      const root = contentLayerRef.current
      if (!root) return

      const target = event.target as Node | null
      if (target && root.contains(target)) {
        // 范围内的 mouseup 已由内容容器的 onMouseUp 处理。
        return
      }

      showSelectionMenuFromCurrentSelection()
    }

    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [canAnnotate, onAddAnnotation, messageId, showSelectionMenuFromCurrentSelection])

  const handleSelectionMenuRequestBack = useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }

    return false
  }, [selectionMenuView, handleCancelFollowUp])

  useAnnotationIslandEvents({
    enabled: allowAnnotationIsland && hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

  const selectionMenu = allowAnnotationIsland ? (
    <AnnotationIslandMenu
      anchor={selectionMenuRenderAnchor}
      sourceKey={selectionMenuRenderSourceKey}
      replayNonce={selectionMenuShowNonce}
      isVisible={isSelectionMenuVisible}
      activeView={selectionMenuView}
      mode={followUpMode}
      draft={followUpDraft}
      onDraftChange={setFollowUpDraft}
      onOpenFollowUp={handleOpenFollowUpView}
      onCancel={handleCancelFollowUp}
      onRequestBack={handleSelectionMenuRequestBack}
      onRequestEdit={handleRequestFollowUpEdit}
      onSubmit={handleSubmitFollowUp}
      onSubmitAndSend={handleSubmitAndSendFollowUp}
      onDelete={activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined}
      sendMessageKey={sendMessageKey}
      transitionConfig={selectionMenuTransitionConfig}
      onExitComplete={handleSelectionMenuExitComplete}
      usePortal={shouldRenderAnnotationIslandInPortal('turncard')}
    />
  ) : null

  const annotationOverlayLayer = (
    <AnnotationOverlayLayer
      rects={annotationOverlay.rects}
      chips={annotationOverlay.chips}
      annotations={renderedAnnotations}
      getTooltipText={(annotation) => formatAnnotationFollowUpTooltipText(annotation)}
      allowChipOpen={allowAnnotationIsland}
      onChipOpen={({ annotationId, index, anchorX, anchorY, mode }) => {
        handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
      }}
    />
  )

  // 流式输出时节流内容更新以提升性能
  // 流式结束时立即更新以展示最终内容
  useEffect(() => {
    if (!isStreaming) {
      // 流式结束——立即展示最终内容
      setDisplayedText(text)
      return
    }

    const now = Date.now()
    const elapsed = now - lastUpdateRef.current

    if (elapsed >= BUFFER_CONFIG.CONTENT_THROTTLE_MS) {
      // 已过足够时间——立即更新
      setDisplayedText(text)
      lastUpdateRef.current = now
    } else {
      // 为剩余时间安排更新
      const timeout = setTimeout(() => {
        setDisplayedText(text)
        lastUpdateRef.current = Date.now()
      }, BUFFER_CONFIG.CONTENT_THROTTLE_MS - elapsed)
      return () => clearTimeout(timeout)
    }
  }, [text, isStreaming])

  // 基于当前文本（非展示文本）计算缓冲决策
  const bufferDecision = useMemo(() => {
    return shouldShowContent(text, isStreaming, streamStartTime)
  }, [text, isStreaming, streamStartTime])

  const isCompleted = !isStreaming
  const isBuffering = isStreaming && !bufferDecision.shouldShow

  // 缓冲期间返回 null——TurnCard 会展示轻微提示
  if (isBuffering) {
    return null
  }

  // 已完成的响应或 plan——展示最大高度和页脚
  if (isCompleted || variant === 'plan') {
    const isPlan = variant === 'plan'

    return (
      <>
        <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden relative group">
          {/* 全屏按钮——仅桌面端；compact 模式保持消息外壳最小化 */}
          {!compactMode && (
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              "absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10 select-none",
              "opacity-0 group-hover:opacity-100",
              "bg-background shadow-minimal",
              "text-muted-foreground/50 hover:text-foreground",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
            )}
            title={t('common.viewFullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          )}

          {/* plan 头部——仅 plan 变体展示 */}
          {isPlan && (
            <div
              className={cn(
                "px-4 py-2 border-b border-border/30 flex items-center gap-2 bg-success/5 select-none",
                SIZE_CONFIG.fontSize
              )}
            >
              <ListTodo className={cn(SIZE_CONFIG.iconSize, "text-success")} />
              <span className="font-medium text-success">Plan</span>
            </div>
          )}

          {/* 可滚动内容区，边缘带轻微渐变（仅暗色模式） */}
          <div
            ref={contentRef}
            data-search-root="response"
            onMouseDown={handleSelectionPointerDown}
            onMouseUp={handleTextSelection}
            className="pl-[22px] pr-[16px] py-3 text-sm overflow-y-auto scrollbar-hover"
            style={{
              maxHeight: MAX_HEIGHT,
              // 顶/底边缘的轻微渐变（16px）——仅暗色模式以获得更好对比度
              ...(isDarkMode && {
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
              }),
            }}
          >
            <div ref={contentLayerRef} className="relative">
              <Markdown
                mode="minimal"
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
              >
                {text}
              </Markdown>
              {annotationOverlayLayer}
            </div>
          </div>

          {/* 桌面端页脚，含操作按钮（Copy / Markdown / Accept Plan / Branch）。
              compact 模式走下方仅 Accept Plan 的精简页脚。 */}
          {!compactMode && (
            <div className={cn(
              "pl-4 pr-2.5 py-2 border-t border-border/30 flex items-center justify-between bg-muted/20",
              SIZE_CONFIG.fontSize
            )}>
              {/* 左侧——Copy、View as Markdown、批注提示 */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleCopy}
                  className={cn(
                    "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                    copied ? "text-success" : "text-muted-foreground hover:text-foreground",
                    "focus:outline-none focus-visible:underline"
                  )}
                >
                  {copied ? (
                    <>
                      <Check className={SIZE_CONFIG.iconSize} />
                      <span>{t("common.copied")}</span>
                    </>
                  ) : (
                    <>
                      <Copy className={SIZE_CONFIG.iconSize} />
                      <span>{t("common.copy")}</span>
                    </>
                  )}
                </button>
                {onPopOut && (
                  <button
                    onClick={onPopOut}
                    className={cn(
                      "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                      "text-muted-foreground hover:text-foreground",
                      "focus:outline-none focus-visible:underline"
                    )}
                  >
                    <FileText className={SIZE_CONFIG.iconSize} />
                    <span>Markdown</span>
                  </button>
                )}
              </div>

              {/* 右侧 */}
              <div className="flex items-center gap-3">
                {/* Accept Plan 下拉菜单（仅 plan 变体，最后一条响应） */}
                {isPlan && showAcceptPlan && onAccept && onAcceptWithCompact && (
                  <div
                    className={cn(
                      "flex items-center gap-3 transition-all duration-200",
                      isLastResponse
                        ? "opacity-100 translate-x-0"
                        : "opacity-0 translate-x-2 pointer-events-none"
                    )}
                  >
                    <AcceptPlanDropdown
                      onAccept={onAccept}
                      onAcceptWithCompact={onAcceptWithCompact}
                      acceptLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.acceptPlan')}
                      acceptOptionLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.accept')}
                    />
                  </div>
                )}
                {onBranch && <BranchDropdown onBranch={onBranch} />}
              </div>
            </div>
          )}

          {/* compact 页脚——仅 Accept Plan（移动端 / 自动 compact / popover）。
              使用 bottom-sheet drawer 以匹配 CompactPermissionModeSelector
              / CompactModelSelector 模式。用 isLastResponse 守卫，使旧的
              plan 不会渲染出带隐藏但可聚焦按钮的空条。 */}
          {compactMode && isPlan && showAcceptPlan && isLastResponse && onAccept && onAcceptWithCompact && (
            <div
              className={cn(
                "pl-3 pr-2 py-1.5 border-t border-border/30 flex items-center justify-end bg-muted/20",
                SIZE_CONFIG.fontSize
              )}
            >
              <CompactAcceptPlanDrawer
                onAccept={onAccept}
                onAcceptWithCompact={onAcceptWithCompact}
                acceptLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.acceptPlan')}
                acceptOptionLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.accept')}
              />
            </div>
          )}
        </div>

        {/* 用于阅读/批注响应和 plan 内容的全屏遮罩。 */}
        <DocumentFormattedMarkdownOverlay
          content={text}
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          variant={isPlan ? 'plan' : undefined}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
          sessionId={sessionId}
          messageId={messageId}
          annotations={annotations}
          onAddAnnotation={onAddAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          sendMessageKey={sendMessageKey}
          openAnnotationRequest={openAnnotationRequest}
          isStreaming={isStreaming}
        />
        {selectionMenu}
      </>
    )
  }

  // 流式响应——展示节流后的内容并带 spinner
  return (
    <>
      <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden group">
        {/* 内容区——使用 displayedText（节流后）以提升性能 */}
        {/* 顶/底边缘的轻微渐变（仅暗色模式） */}
        <div
          ref={contentRef}
          data-search-root="response"
          onMouseDown={handleSelectionPointerDown}
          onMouseUp={handleTextSelection}
          className="pl-[22px] pr-4 py-3 text-sm overflow-y-auto scrollbar-hover"
          style={{
            maxHeight: MAX_HEIGHT,
            // 顶/底边缘的轻微渐变（16px）——仅暗色模式以获得更好对比度
            ...(isDarkMode && {
              maskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
            }),
          }}
        >
          <div ref={contentLayerRef} className="relative">
            <Markdown
              mode="minimal"
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            >
              {displayedText}
            </Markdown>
            {annotationOverlayLayer}
          </div>
        </div>

        {/* 桌面端流式页脚；compact 模式此处不渲染
            （Accept-Plan 页脚仅适用于已完成的 plan）。 */}
        {!compactMode && (
          <div className={cn("px-4 py-2 border-t border-border/30 flex items-center bg-muted/20", SIZE_CONFIG.fontSize)}>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner className={SIZE_CONFIG.spinnerSize} />
              <span>Streaming...</span>
            </div>
          </div>
        )}
      </div>
      {selectionMenu}
    </>
  )
}

// ============================================================================
// TodoList 组件（用于 TodoWrite 工具可视化）
// ============================================================================

/** todo 项的状态图标——完成时使用紫色实心图标 */
function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'pending':
      return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
    case 'in_progress':
      return (
        <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
        </div>
      )
    case 'completed':
      return <CircleCheck className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
    case 'interrupted':
      return <Ban className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
  }
}

/** 单个 todo 行——样式类似 ActivityRow */
function TodoRow({ todo }: { todo: TodoItem }) {
  const displayText = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content

  return (
    <div className={cn(
      "flex items-center gap-2 py-0.5 text-muted-foreground",
      SIZE_CONFIG.fontSize,
      todo.status === 'completed' && "opacity-50"
    )}>
      <TodoStatusIcon status={todo.status} />
      <span className={cn(
        "truncate flex-1",
        todo.status === 'completed' && "line-through"
      )}>
        {displayText}
      </span>
    </div>
  )
}

interface TodoListProps {
  todos: TodoItem[]
}

/**
 * TodoList - 展示 TodoWrite 工具的当前状态
 * 样式与 TurnCard activity 融合
 */
function TodoList({ todos }: TodoListProps) {
  if (todos.length === 0) return null

  return (
    <div className="pl-4 pr-2 pt-2.5 pb-1.5 space-y-0.5 border-l-2 border-muted ml-[13px]">
      {/* 头部 */}
      <div className={cn("text-muted-foreground pb-1", SIZE_CONFIG.fontSize)}>
        Todo List
      </div>
      {/* Todo 项 */}
      {todos.map((todo, index) => (
        <motion.div
          key={`${todo.content}-${index}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.03 }}
        >
          <TodoRow todo={todo} />
        </motion.div>
      ))}
    </div>
  )
}

// ============================================================================
// 主组件
// ============================================================================

/**
 * TurnCard - 类邮件的单个助手 turn 展示
 *
 * 将所有 activity（工具、思考）批量收纳到可折叠区域，
 * 最终响应单独展示在下方。
 *
 * 使用 memo 避免会话切换时已完成 turn 重渲染。
 * 仅对完成且非流式的 turn 做 memo——活跃 turn 始终重渲染。
 */
export const TurnCard = React.memo(function TurnCard({
  sessionId,
  turnId,
  activities,
  response,
  intent,
  isStreaming,
  isComplete,
  defaultExpanded = false,
  isExpanded: externalIsExpanded,
  onExpandedChange,
  expandedActivityGroups: externalExpandedActivityGroups,
  onExpandedActivityGroupsChange,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  onOpenDetails,
  onOpenActivityDetails,
  onOpenMultiFileDiff,
  hasEditOrWriteActivities,
  todos,
  renderActionsMenu,
  onAcceptPlan,
  onAcceptPlanWithCompact,
  isLastResponse,
  sessionFolderPath,
  displayMode = 'detailed',
  animateResponse = false,
  compactMode = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
}: TurnCardProps) {
  // 使用状态机从 props 推导 turn 阶段。
  // 这为生命周期状态提供单一真相来源，
  // 替代旧的临时布尔组合。
  const turnPhase = useMemo(() => {
    // 为 deriveTurnPhase 构造最小化的 turn-like 对象
    const turnData: Pick<AssistantTurn, 'isComplete' | 'response' | 'activities'> = {
      isComplete,
      response,
      activities,
    }
    return deriveTurnPhase(turnData as AssistantTurn)
  }, [isComplete, response, activities])

  // 若未提供受控状态则使用本地状态
  const [localExpandedTurns, setLocalExpandedTurns] = useState<Set<string>>(() => defaultExpanded ? new Set([turnId]) : new Set())
  const isExpanded = externalIsExpanded ?? localExpandedTurns.has(turnId)

  // 跟踪用户是否手动切换过展开（初始挂载时跳过动画）
  const hasUserToggled = useRef(false)

  // 可滚动 activity 容器的 ref（展开时滚动到底部）
  const activitiesContainerRef = useRef<HTMLDivElement>(null)

  // 跟踪组件是否已挂载（挂载后为新 activity 启用淡入动画）
  const hasMounted = useRef(false)
  useEffect(() => {
    hasMounted.current = true
  }, [])

  const toggleExpanded = useCallback(() => {
    hasUserToggled.current = true
    const newExpanded = !isExpanded
    if (onExpandedChange) {
      onExpandedChange(newExpanded)
    } else {
      setLocalExpandedTurns(prev => {
        const next = new Set(prev)
        if (next.has(turnId)) {
          next.delete(turnId)
        } else {
          next.add(turnId)
        }
        return next
      })
    }
  }, [turnId, isExpanded, onExpandedChange])

  // 用户手动展开时滚动到 activity 列表底部
  // 这样展示最新的步骤而非最旧的
  useEffect(() => {
    if (isExpanded && hasUserToggled.current && activitiesContainerRef.current) {
      // 等待展开动画完成（250ms）再滚动
      const timer = setTimeout(() => {
        activitiesContainerRef.current?.scrollTo({
          top: activitiesContainerRef.current.scrollHeight,
          behavior: 'smooth'
        })
      }, 260)
      return () => clearTimeout(timer)
    }
  }, [isExpanded])

  // 若未提供受控状态则使用本地状态管理 activity 分组
  const [localExpandedActivityGroups, setLocalExpandedActivityGroups] = useState<Set<string>>(new Set())
  const expandedActivityGroups = externalExpandedActivityGroups ?? localExpandedActivityGroups
  const handleExpandedActivityGroupsChange = onExpandedActivityGroupsChange ?? setLocalExpandedActivityGroups

  // 检查响应是否处于缓冲状态
  // 无需轮询——父组件更新会自然触发重新评估
  const isBuffering = useMemo(
    () => isResponseBuffering(response),
    [response]
  )


  // 计算预览文本，带交叉淡入动画
  const previewText = useMemo(
    () => getPreviewText(activities, intent, isStreaming, !!response, isComplete),
    [activities, intent, isStreaming, response, isComplete]
  )

  // 按时间戳排序 activity 以获得正确的时序
  // 这处理实时流式场景（turn-utils 在 flush 时对已完成 turn 排序）
  const allSortedActivities = useMemo(
    () => [...activities].sort((a, b) => a.timestamp - b.timestamp),
    [activities]
  )

  // 将 plan activity 与普通 activity 分离
  // plan 渲染为完整 ResponseCard，而非放在可折叠 activity 区域
  const planActivities = useMemo(
    () => allSortedActivities.filter(a => a.type === 'plan'),
    [allSortedActivities]
  )
  const sortedActivities = useMemo(
    () => allSortedActivities.filter(a => a.type !== 'plan'),
    [allSortedActivities]
  )

  // 检查是否有 Task 子代理——有则使用分组视图
  const hasTaskSubagents = useMemo(
    () => sortedActivities.some(a => isParentTaskTool(a.toolName ?? '')),
    [sortedActivities]
  )

  // 按父级 Task 分组 activity 以获得更好的可视化
  // 仅当存在 Task 子代理时分组，否则保持扁平以简化视图
  const groupedActivities = useMemo(
    () => hasTaskSubagents ? groupActivitiesByParent(sortedActivities) : null,
    [sortedActivities, hasTaskSubagents]
  )

  // 预计算哪些 activity 是末位子项——O(n) 替代每次渲染 O(n²) 检查
  // 仅用于扁平视图（非分组）
  const lastChildSet = useMemo(
    () => !hasTaskSubagents ? computeLastChildSet(sortedActivities) : new Set<string>(),
    [sortedActivities, hasTaskSubagents]
  )

  // 没有内容可展示且 turn 已完成时不渲染
  if (activities.length === 0 && !response && isComplete) {
    return null
  }

  // 不渲染在任何有意义工作之前就被中断的 turn。
  // 满足以下条件时隐藏 turn：
  // - 所有工具 activity 都是错误（没有成功完成的）
  // - 所有中间 activity 都没有有意义内容（空或仅有空白）
  // - 没有响应文本可展示
  // - 没有 plan activity
  // 仅"Response interrupted"提示横幅已足够反馈。
  const hasNoMeaningfulWork = activities.length > 0
    && activities.every(a => {
      // 工具 activity 必须是错误（中断/失败）
      if (a.type === 'tool') return a.status === 'error'
      // 中间 activity 必须没有有意义内容
      if (a.type === 'intermediate') return !a.content?.trim()
      // plan activity 视为有意义工作
      if (a.type === 'plan') return false
      // 其他 activity 类型——视为无有意义工作
      return true
    })
    && !response
  if (hasNoMeaningfulWork) {
    return null
  }

  // 仅统计非 plan activity 用于可折叠区域
  const hasActivities = sortedActivities.length > 0

  // 使用基于阶段的状态机判断是否应展示思考指示器。
  // 这正确处理了工具完成到下一个动作之间的"间隙"状态（awaiting），
  // 此前该状态曾导致 turn 卡片"消失"。
  const isThinking = shouldShowThinkingIndicator(turnPhase, isBuffering)

  return (
    <div className="space-y-1">
      {/* Activity 区域——排除搜索高亮（与 ripgrep 行为一致） */}
      {hasActivities && (
        <div className="group select-none" data-search-exclude="true">
          {/* 折叠头部 / 切换 */}
          <button
            onClick={toggleExpanded}
            className={cn(
              "flex items-center gap-2 w-full pl-2.5 pr-1.5 py-1.5 rounded-[8px] text-left",
              SIZE_CONFIG.fontSize,
              "text-muted-foreground",
              "hover:bg-muted/50 transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            {/* 带旋转动画的 chevron——与 activity 行图标对齐 */}
            <motion.div
              initial={false}
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
            >
              <ChevronRight className={SIZE_CONFIG.iconSize} />
            </motion.div>

            {/* 步骤计数徽章 */}
            <span className="-ml-0.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-background shadow-minimal text-[10px] font-medium tabular-nums">
              {activities.length}
            </span>

            {/* 带交叉淡入的预览文本 + 行内失败计数 */}
            <span className="relative flex-1 min-w-0 h-5 flex items-center">
              <AnimatePresence initial={false}>
                <motion.span
                  key={previewText}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 truncate"
                >
                  {previewText}
                </motion.span>
              </AnimatePresence>
            </span>

            {/* turn 操作菜单——使用平台覆盖或默认 */}
            {renderActionsMenu ? renderActionsMenu() : (
              <TurnCardActionsMenu
                onOpenDetails={onOpenDetails}
                onOpenMultiFileDiff={onOpenMultiFileDiff}
                hasEditOrWriteActivities={hasEditOrWriteActivities}
              />
            )}
          </button>

          {/* 展开 activity 列表 */}
          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  height: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
                  opacity: { duration: 0.15 }
                }}
                className="overflow-hidden"
              >
                {/* activity 较多时的可滚动容器——带轻微背景以提供滚动上下文 */}
                {/* ml-[15px] 将 border-l 定位到 chevron 下方 */}
                <div
                  ref={activitiesContainerRef}
                  className={cn(
                    "pl-4 pr-2 py-0 space-y-0.5 border-l-2 border-muted ml-[13px]",
                    sortedActivities.length > SIZE_CONFIG.maxVisibleActivities && "rounded-r-md overflow-y-auto scrollbar-hover py-1.5"
                  )}
                  style={{
                    maxHeight: sortedActivities.length > SIZE_CONFIG.maxVisibleActivities
                      ? SIZE_CONFIG.maxVisibleActivities * SIZE_CONFIG.activityRowHeight
                      : undefined
                  }}
                >
                  <AnimatePresence mode="sync">
                  {/* Task 子代理的分组视图 */}
                  {groupedActivities ? (
                    groupedActivities.map((item, index) => (
                      isActivityGroup(item) ? (
                        <ActivityGroupRow
                          key={item.parent.id}
                          group={item}
                          expandedGroups={expandedActivityGroups}
                          onExpandedGroupsChange={handleExpandedActivityGroupsChange}
                          onOpenActivityDetails={onOpenActivityDetails}
                          animationIndex={index}
                          sessionFolderPath={sessionFolderPath}
                          displayMode={displayMode}
                        />
                      ) : (
                        <motion.div
                          key={item.id}
                          initial={
                            hasUserToggled.current || hasMounted.current
                              ? { opacity: 0, x: -8 }
                              : false
                          }
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                        >
                          <ActivityRow
                            activity={item}
                            onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(item) : undefined}
                            sessionFolderPath={sessionFolderPath}
                            displayMode={displayMode}
                          />
                        </motion.div>
                      )
                    ))
                  ) : (
                    /* 简单工具调用的扁平视图 */
                    sortedActivities.map((activity, index) => (
                      <motion.div
                        key={activity.id}
                        initial={
                          hasUserToggled.current || hasMounted.current
                            ? { opacity: 0, x: -8 }
                            : false
                        }
                        animate={{ opacity: 1, x: 0 }}
                        // 仅在用户切换时动画，初始挂载不动画
                        transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                      >
                        <ActivityRow
                          activity={activity}
                          onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(activity) : undefined}
                          isLastChild={lastChildSet.has(activity.id)}
                          sessionFolderPath={sessionFolderPath}
                          displayMode={displayMode}
                        />
                      </motion.div>
                    ))
                  )}
                  {/* 思考/缓冲指示器——等待响应时展示 */}
                  {isThinking && !animateResponse && (
                    <motion.div
                      key="thinking"
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        delay: Math.min(sortedActivities.length, SIZE_CONFIG.staggeredAnimationLimit) * 0.03,
                        duration: 0.3,
                        ease: "easeOut"
                      }}
                      className={cn("flex items-center gap-2 py-0.5 text-muted-foreground/70", SIZE_CONFIG.fontSize)}
                    >
                      <Spinner className={SIZE_CONFIG.spinnerSize} />
                      <span>{isBuffering ? 'Preparing response...' : 'Thinking...'}</span>
                    </motion.div>
                  )}
                  </AnimatePresence>
                </div>
                {/* TodoList——展开区域内 */}
                {todos && todos.length > 0 && (
                  <TodoList todos={todos} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* 独立思考指示器——无 activity 但仍在工作时展示 */}
      {!hasActivities && isThinking && !animateResponse && (
        <div className={cn("flex items-center gap-2 px-3 py-1.5 text-muted-foreground", SIZE_CONFIG.fontSize)}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
          <span>{isBuffering ? 'Preparing response...' : 'Thinking...'}</span>
        </div>
      )}

      {/* plan activity——渲染为完整 ResponseCard，与其他 activity 按时间排序 */}
      {planActivities.map((planActivity, index) => (
        <div key={planActivity.id} className={cn("select-text", (hasActivities || index > 0) && "mt-2")}>
          <ResponseCard
            text={planActivity.content || ''}
            isStreaming={false}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            onPopOut={onPopOut ? () => onPopOut(planActivity.content || '') : undefined}
            variant="plan"
            messageId={planActivity.messageId}
            annotations={planActivity.annotations}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onSaveAndSendFollowUp={onSaveAndSendFollowUp}
            onAccept={onAcceptPlan}
            onAcceptWithCompact={onAcceptPlanWithCompact}
            isLastResponse={isLastResponse && index === planActivities.length - 1}
            compactMode={compactMode}
            onBranch={onBranch ? (options?: { newPanel?: boolean }) => onBranch(planActivity.messageId ?? planActivity.id, options) : undefined}
            sendMessageKey={sendMessageKey}
            hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
            openAnnotationRequest={openAnnotationRequest}
            annotationInteractionMode={annotationInteractionMode}
          />
        </div>
      ))}

      {/* 响应区域——仅在非缓冲时展示 */}
      {/* playground 演示用的动画版本 */}
      {animateResponse && (
        <AnimatePresence>
          {response && !isBuffering && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className={cn("select-text", hasActivities && "mt-2")}
            >
              <ResponseCard
                text={response.text}
                isStreaming={response.isStreaming}
                streamStartTime={response.streamStartTime}
                sessionId={sessionId}
                onOpenFile={onOpenFile}
                onOpenUrl={onOpenUrl}
                onPopOut={onPopOut ? () => onPopOut(response.text) : undefined}
                variant={response.isPlan ? 'plan' : 'response'}
                messageId={response.messageId}
                annotations={response.annotations}
                onAddAnnotation={onAddAnnotation}
                onRemoveAnnotation={onRemoveAnnotation}
                onUpdateAnnotation={onUpdateAnnotation}
                onSaveAndSendFollowUp={onSaveAndSendFollowUp}
                onAccept={onAcceptPlan}
                onAcceptWithCompact={onAcceptPlanWithCompact}
                isLastResponse={isLastResponse}
                compactMode={compactMode}
                onBranch={onBranch && response.messageId ? (options?: { newPanel?: boolean }) => onBranch(response.messageId!, options) : undefined}
                sendMessageKey={sendMessageKey}
                hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
                openAnnotationRequest={openAnnotationRequest}
                annotationInteractionMode={annotationInteractionMode}
              />
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {/* 常规应用使用的非动画版本 */}
      {!animateResponse && response && !isBuffering && (
        <div className={cn("select-text", hasActivities && "mt-2")}>
          <ResponseCard
            text={response.text}
            isStreaming={response.isStreaming}
            streamStartTime={response.streamStartTime}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            onPopOut={onPopOut ? () => onPopOut(response.text) : undefined}
            variant={response.isPlan ? 'plan' : 'response'}
            messageId={response.messageId}
            annotations={response.annotations}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onSaveAndSendFollowUp={onSaveAndSendFollowUp}
            onAccept={onAcceptPlan}
            onAcceptWithCompact={onAcceptPlanWithCompact}
            isLastResponse={isLastResponse}
            compactMode={compactMode}
            onBranch={onBranch && response.messageId ? (options?: { newPanel?: boolean }) => onBranch(response.messageId!, options) : undefined}
            sendMessageKey={sendMessageKey}
            hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
            openAnnotationRequest={openAnnotationRequest}
            annotationInteractionMode={annotationInteractionMode}
          />
        </div>
      )}
    </div>
  )
}, (prev, next) => {
  // 保守 memo：仅对已完成、非流式的 turn 跳过重渲染
  // 活跃 turn（流式或未完成）始终重渲染以展示更新

  // 流式 turn 始终重渲染
  if (prev.isStreaming || next.isStreaming) return false

  // 未完成 turn 始终重渲染
  if (!prev.isComplete || !next.isComplete) return false

  // 展开状态变化时重渲染
  if (prev.isExpanded !== next.isExpanded) return false
  if (prev.expandedActivityGroups !== next.expandedActivityGroups) return false

  // isLastResponse 变化时重渲染（影响 Accept Plan 按钮可见性）
  if (prev.isLastResponse !== next.isLastResponse) return false

  // displayMode 变化时重渲染
  if (prev.displayMode !== next.displayMode) return false

  // compactMode 变化时重渲染（影响 ResponseCard 页脚渲染）
  if (prev.compactMode !== next.compactMode) return false

  // 批注交互模式变化时重渲染（interactive vs tooltip-only）
  if (prev.annotationInteractionMode !== next.annotationInteractionMode) return false

  // activity 变化时重渲染（对 playground/测试场景重要）
  if (prev.activities !== next.activities) return false

  // response 对象变化时重渲染（例如批注更新）
  if (prev.response !== next.response) return false

  // 外部批注打开请求变化时重渲染
  if (prev.openAnnotationRequest !== next.openAnnotationRequest) return false

  // 活跃 follow-up 批注状态变化时重渲染（plan CTA 标签）
  if (prev.hasActiveFollowUpAnnotations !== next.hasActiveFollowUpAnnotations) return false

  // 对于完成、非流式的 turn：仅当会话和 turn 标识都匹配时跳过重渲染。
  // 防止旧本地 UI 状态在可能复用 turn ID/组件的会话切换间泄漏。
  return prev.sessionId === next.sessionId && prev.turnId === next.turnId
})
