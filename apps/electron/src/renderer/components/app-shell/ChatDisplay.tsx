import * as React from "react"
import { useTranslation } from "react-i18next"
import { useEffect, useState, useMemo, useCallback } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  ExternalLink,
  Info,
  X,
} from "lucide-react"
import { motion, AnimatePresence } from "motion/react"
import { toast } from "sonner"

import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { coerceInputText, appendRestoredInput } from "@/lib/input-text"
import { Markdown, CollapsibleMarkdownProvider, StreamingMarkdown, type RenderMode } from "@/components/markdown"
import { AnimatedCollapsibleContent } from "@/components/ui/collapsible"
import {
  Spinner,
  parseReadResult,
  parseBashResult,
  parseGrepResult,
  parseGlobResult,
  extractOverlayData,
  extractOverlayCards,
  ActivityCardsOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  GenericOverlay,
  JSONPreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  detectLanguage,
  type ActivityItem,
  type FileChange,
  type DiffViewerSettings,
} from "@craft-agent/ui"
import { useFocusZone } from "@/hooks/keyboard"
import { useTheme } from "@/hooks/useTheme"
import type { Session, Message, FileAttachment, StoredAttachment, PermissionRequest, CredentialRequest, CredentialResponse, LoadedSource, LoadedSkill } from "../../../shared/types"
import type { PermissionMode } from "@craft-agent/shared/agent/modes"
import type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels"
import {
  TurnCard,
  UserMessageBubble,
  groupMessagesByTurn,
  formatTurnAsMarkdown,
  formatActivityAsMarkdown,
  getAssistantTurnUiKey,
  asRecord,
  getAnnotationNoteText,
  isAnnotationFollowUpSent,
  extractAnnotationSelectedText,
  normalizeFollowUpText,
  type Turn,
  type AssistantTurn,
  type UserTurn,
  type SystemTurn,
  type AuthRequestTurn,
} from "@craft-agent/ui"
import { MemoizedAuthRequestCard } from "@/components/chat/AuthRequestCard"
import { ChatInputZone, type StructuredInputState, type StructuredResponse, type PermissionResponse, type AdminApprovalResponse } from "./input"
import type { RichTextInputHandle } from "@/components/ui/rich-text-input"
import { useBackgroundTasks } from "@/hooks/useBackgroundTasks"
import { useTurnCardExpansion } from "@/hooks/useTurnCardExpansion"
import { useNavigation } from "@/contexts/NavigationContext"
import { useAppShellContext } from "@/context/AppShellContext"
import { navigate, routes } from "@/lib/navigate"
import { CHAT_LAYOUT } from "@/config/layout"
import { collectFileChangesFromActivities, getFirstFileChangeIdForActivity } from "@/lib/file-changes"
import { resolveBranchNewPanelOption } from "./branching"
import { handleErrorMessageAction } from "./error-message-actions"

// ============================================================================
// CSS Custom Highlight API 辅助函数
// ============================================================================

/** 惰性访问 CSS.highlights —— 避免模块初始化 / HMR 时机导致的过期引用 */
function getCSSHighlights(): Map<string, Highlight> | undefined {
  try {
    return (CSS as any).highlights as Map<string, Highlight> | undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// Overlay 状态类型
// ============================================================================

/** multi-diff overlay(Edit/Write 活动)的状态 */
interface MultiDiffOverlayState {
  type: 'multi-diff'
  changes: FileChange[]
  consolidated: boolean
  focusedChangeId?: string
}

/** markdown overlay(弹出、turn 详情、通用活动)的状态 */
interface MarkdownOverlayState {
  type: 'markdown'
  content: string
  title: string
  /** 为 true 时,在 code viewer 中展示原始 markdown 源码而非渲染后的预览 */
  forceCodeView?: boolean
}

/** 所有 overlay 状态的联合类型,或 null 表示无 overlay */
type OverlayState =
  | { type: 'activity'; activity: ActivityItem }
  | MultiDiffOverlayState
  | MarkdownOverlayState
  | null

function isStackedActivityTool(activity: ActivityItem): boolean {
  const toolName = activity.toolName?.toLowerCase() || ''
  return toolName === 'bash' || toolName.startsWith('mcp__') || toolName.startsWith('browser_')
}

function getTurnKey(turn: Turn): string {
  if (turn.type === 'user') return `user-${turn.message.id}`
  if (turn.type === 'system') return `system-${turn.message.id}`
  if (turn.type === 'auth-request') return `auth-${turn.message.id}`
  return `turn-${turn.turnId}-${turn.timestamp}`
}

interface ChatDisplayProps {
  session: Session | null
  onSendMessage: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  // 模型选择
  currentModel: string
  onModelChange: (model: string, connection?: string) => void
  // 连接选择(首条消息后锁定)
  /** LLM connection 变化时的回调(仅在 session 为空时生效) */
  onConnectionChange?: (connectionSlug: string) => void
  /** 输入框的 ref,用于外部焦点控制 */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** 为 true 时禁用输入(例如 agent 需要激活时) */
  disabled?: boolean
  /** 当前 session 待处理的权限请求 */
  pendingPermission?: PermissionRequest
  /** 响应权限请求的回调 */
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../../shared/types').PermissionResponseOptions
  ) => void
  /** 当前 session 待处理的凭证请求 */
  pendingCredential?: CredentialRequest
  /** 响应凭证请求的回调 */
  onRespondToCredential?: (sessionId: string, requestId: string, response: CredentialResponse) => void
  // 思考级别(session 级设置)
  /** 当前思考级别('off'、'think'、'max') */
  thinkingLevel?: ThinkingLevel
  /** 思考级别变化时的回调 */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // 高级选项
  /** 当前权限模式 */
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** 用于 Shift+Tab 循环切换的已启用权限模式 */
  enabledModes?: PermissionMode[]
  // 输入值保留(由父级控制)
  /** 当前输入值 - 在模式切换和会话变化间保留 */
  inputValue?: string
  /** 输入值变化时的回调 */
  onInputChange?: (value: string) => void
  /** 该 session 持久化的附件草稿(在 ChatPage 中从磁盘恢复) */
  attachmentsValue?: FileAttachment[]
  /** 附件草稿变化时(添加、删除、发送时清空)的回调 */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  // Source 选择
  /** 可用的 source(仅已启用的) */
  sources?: LoadedSource[]
  /** source 选择变化时的回调 */
  onSourcesChange?: (slugs: string[]) => void
  // Skill 选择(用于 @mentions)
  /** 可用于 @mention 自动补全的 skill */
  skills?: LoadedSkill[]
  // Label 选择(用于 #labels)
  /** 可用的标签配置(树),用于标签菜单与徽标展示 */
  labels?: import('@craft-agent/shared/labels').LabelConfig[]
  /** 标签变化时的回调 */
  onLabelsChange?: (labels: string[]) => void
  // 状态/状态选择(用于 # 菜单和 ActiveOptionBadges)
  /** 可用的工作流状态 */
  sessionStatuses?: import('@/config/session-status-config').SessionStatus[]
  /** session 状态变化时的回调 */
  onSessionStatusChange?: (stateId: string) => void
  /** 用于加载 skill 图标的 workspace ID */
  workspaceId?: string
  // 工作目录(按 session)
  /** 当前 session 的工作目录 */
  workingDirectory?: string
  /** 工作目录变化时的回调 */
  onWorkingDirectoryChange?: (path: string) => void
  /** session 文件夹路径(用于 "Reset to Session Root" 选项) */
  sessionFolderPath?: string
  // 懒加载
  /** 为 true 时表示消息仍在加载 - 在消息区展示 spinner */
  messagesLoading?: boolean
  /** 消息加载失败时展示,而非无限 spinner */
  messagesLoadError?: string | null
  /** 是否正在重试中 */
  messagesRetrying?: boolean
  /** 重试懒加载 session 转录 */
  onRetryMessagesLoad?: () => void
  // 教程
  /** 禁用发送动作(用于教程引导) */
  disableSend?: boolean
  // 搜索高亮(来自 session 列表搜索)
  /** 用于高亮匹配的搜索查询 - 从 session 列表传入 */
  searchQuery?: string
  /** 搜索模式是否激活(防止焦点被抢到 chat 输入框) */
  isSearchModeActive?: boolean
  /** 匹配信息变化时的回调 - 用于即时 UI 更新 */
  onMatchInfoChange?: (info: { count: number; index: number; isHighlighting: boolean; sessionId: string | null }) => void
  // 紧凑模式(用于 EditPopover 嵌入以及 auto-compact / WebUI 移动端)
  /** 启用紧凑模式 - 为 popover 嵌入隐藏非必要的 UI 元素 */
  compactMode?: boolean
  /**
   * 当 compactMode 为 true 时,在权限模式徽标旁启用紧凑的
   * (基于抽屉的)模型选择器。默认为 false,以便 EditPopover 保持
   * 当前行为;ChatPage 在 auto-compact / 移动端时启用。
   */
  enableCompactModelPicker?: boolean
  /** 输入的自定义 placeholder(紧凑模式下用于 edit 上下文) */
  placeholder?: string | string[]
  /** 紧凑模式下作为空状态展示的标签(例如 "Permission Settings") */
  emptyStateLabel?: string
  /** 为 true 时表示 session 锁定的连接已被移除 - 禁用发送并展示不可用状态 */
  connectionUnavailable?: boolean
}

import {
  formatFollowUpSection,
  normalizeFollowUpsMarkdown,
  truncateForChipTooltip,
  type PendingFollowUpAnnotation,
} from './ChatDisplay.follow-ups'

/**
 * 通过 forwardRef 暴露的命令式句柄,用于在匹配项之间导航
 */
export interface ChatDisplayHandle {
  goToNextMatch: () => void
  goToPrevMatch: () => void
  matchCount: number
  currentMatchIndex: number
  isHighlighting: boolean
}

/**
 * 处理中的状态消息 - 在这些消息中随机循环
 * 灵感来自 Claude Code 趣味化的状态消息
 */
const PROCESSING_MESSAGE_KEYS = [
  'chat.processing.thinking',
  'chat.processing.pondering',
  'chat.processing.contemplating',
  'chat.processing.reasoning',
  'chat.processing.processing',
  'chat.processing.computing',
  'chat.processing.considering',
  'chat.processing.reflecting',
  'chat.processing.deliberating',
  'chat.processing.cogitating',
  'chat.processing.ruminating',
  'chat.processing.musing',
  'chat.processing.workingOnIt',
  'chat.processing.onIt',
  'chat.processing.crunching',
  'chat.processing.brewing',
  'chat.processing.connectingDots',
  'chat.processing.mullingItOver',
  'chat.processing.deepInThought',
  'chat.processing.hmm',
  'chat.processing.letMeSee',
  'chat.processing.oneMoment',
  'chat.processing.holdOn',
  'chat.processing.bearWithMe',
  'chat.processing.justASec',
  'chat.processing.hangTight',
  'chat.processing.gettingThere',
  'chat.processing.almost',
  'chat.processing.working',
  'chat.processing.busyBusy',
  'chat.processing.whirring',
  'chat.processing.churning',
  'chat.processing.percolating',
  'chat.processing.simmering',
  'chat.processing.cooking',
  'chat.processing.baking',
  'chat.processing.stirring',
  'chat.processing.spinningUp',
  'chat.processing.warmingUp',
  'chat.processing.revving',
  'chat.processing.buzzing',
  'chat.processing.humming',
  'chat.processing.ticking',
  'chat.processing.clicking',
  'chat.processing.whizzing',
  'chat.processing.zooming',
  'chat.processing.zipping',
  'chat.processing.chugging',
  'chat.processing.trucking',
  'chat.processing.rolling',
]

/**
 * 格式化已耗时:一分钟以内显示 "45s",一分钟及以上显示 "1:02"
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

interface ProcessingIndicatorProps {
  /** 起始时间戳(跨重挂载保留) */
  startTime?: number
  /** 用显式状态覆盖循环消息(例如 "Compacting...") */
  statusMessage?: string
}

/**
 * ProcessingIndicator - 展示循环的状态消息及已耗时
 * 与 TurnCard 头部布局保持一致,以保证视觉连贯性
 */
function ProcessingIndicator({ startTime, statusMessage }: ProcessingIndicatorProps) {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = React.useState(0)
  const [messageIndex, setMessageIndex] = React.useState(() =>
    Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
  )

  // 使用传入的 startTime,每秒更新一次已耗时
  React.useEffect(() => {
    const start = startTime || Date.now()
    // 立即设置初始已耗时
    setElapsed(Math.floor((Date.now() - start) / 1000))

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startTime])

  // 每 10 秒循环切换消息(仅在未展示状态消息时)
  React.useEffect(() => {
    if (statusMessage) return  // 展示状态消息时不循环
    const interval = setInterval(() => {
      setMessageIndex(prev => {
        // 随机挑选一条不同的消息
        let next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        while (next === prev && PROCESSING_MESSAGE_KEYS.length > 1) {
          next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        }
        return next
      })
    }, 10000)
    return () => clearInterval(interval)
  }, [statusMessage])

  // 若提供了状态消息则使用之,否则循环默认消息
  const displayMessage = statusMessage || t(PROCESSING_MESSAGE_KEYS[messageIndex])

  return (
    <div className="flex items-center gap-2 px-3 py-1 -mb-1 text-[13px] text-muted-foreground">
      {/* Spinner 位于与 TurnCard chevron 相同的位置 */}
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      {/* 仅在内容变化时做 crossfade 动画的标签 */}
      <span className="relative h-5 flex items-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={displayMessage}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeInOut' }}
          >
            {displayMessage}
          </motion.span>
        </AnimatePresence>
        {elapsed >= 1 && (
          <span className="text-muted-foreground/60 ml-1 tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * 在挂载时、浏览器绘制之前滚动到目标元素。
 * 使用 useLayoutEffect 以确保滚动发生在内容可见之前。
 */
function ScrollOnMount({
  targetRef,
  onScroll,
  skip = false
}: {
  targetRef: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
  skip?: boolean
}) {
  React.useLayoutEffect(() => {
    if (skip) return
    targetRef.current?.scrollIntoView({ behavior: 'instant' })
    onScroll?.()
  }, [skip])
  return null
}

/**
 * ChatDisplay - 选中 session 的主聊天界面
 *
 * 结构:
 * - Session Header:头像 + workspace 名称
 * - 消息区:可滚动的 MessageBubble 组件列表
 * - 输入区:Textarea + Send 按钮
 *
 * 未选中 session 时展示空状态
 */
export const ChatDisplay = React.forwardRef<ChatDisplayHandle, ChatDisplayProps>(function ChatDisplay({
  session,
  onSendMessage,
  onOpenFile,
  onOpenUrl,
  currentModel,
  onModelChange,
  onConnectionChange,
  textareaRef: externalTextareaRef,
  disabled = false,
  pendingPermission,
  onRespondToPermission,
  pendingCredential,
  onRespondToCredential,
  // 思考级别
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  // 高级选项
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes,
  // 输入值保留
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  // Sources
  sources,
  onSourcesChange,
  // Skills(用于 @mentions)
  // Skills(用于 @mentions)
  skills,
  // Labels(用于 #labels)
  labels,
  onLabelsChange,
  // States(用于 # 菜单与徽标)
  sessionStatuses,
  onSessionStatusChange,
  workspaceId,
  // 工作目录
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  // 懒加载
  messagesLoading = false,
  messagesLoadError,
  messagesRetrying = false,
  onRetryMessagesLoad,
  // 教程
  disableSend = false,
  // 搜索高亮
  searchQuery: externalSearchQuery,
  isSearchModeActive = false,
  onMatchInfoChange,
  // 紧凑模式(用于 EditPopover 嵌入以及 auto-compact / WebUI 移动端)
  compactMode = false,
  enableCompactModelPicker = false,
  placeholder,
  emptyStateLabel,
  // 连接不可用
  connectionUnavailable = false,
}, ref) {
  const { t } = useTranslation()

  // 面板焦点状态(用于多面板的自动滚动行为)
  const appShellContext = useAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // 仅在显式禁用时禁用输入(例如 agent 需要激活)
  // 用户可在流式输出期间输入 - 提交时会停止流并发送
  const isInputDisabled = disabled
  const messagesEndRef = React.useRef<HTMLDivElement>(null)
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const prevSessionIdRef = React.useRef<string | null>(null)
  // 反向分页:初始展示最后 N 个 turn,向上滚动时加载更多
  const TURNS_PER_PAGE = 20
  const [visibleTurnCount, setVisibleTurnCount] = React.useState(TURNS_PER_PAGE)
  // 粘底:为 true 时,内容变化会自动滚动。由用户的滚动行为切换。
  const isStickToBottomRef = React.useRef(true)
  // 将 isFocusedPanel 同步到 ref,以便 ResizeObserver 闭包读取到最新值
  const isFocusedPanelRef = React.useRef(isFocusedPanel)
  isFocusedPanelRef.current = isFocusedPanel
  // session 切换后短暂跳过平滑滚动(瞬时滚动已经完成)
  const skipSmoothScrollUntilRef = React.useRef(0)
  // 追踪消息提交的边界,以便在新用户消息真正落到 state 时自动滚动
  // (当附件导致乐观插入延迟时尤为重要)。
  const prevLastMessageIdRef = React.useRef<string | null>(null)
  const prevMessageCountRef = React.useRef(0)
  const prevSessionIdForCommitScrollRef = React.useRef<string | null>(null)
  const internalTextareaRef = React.useRef<RichTextInputHandle>(null)
  const textareaRef = externalTextareaRef || internalTextareaRef
  const [sendMessageKey, setSendMessageKey] = useState<'enter' | 'cmd-enter'>('enter')
  const [openAnnotationRequest, setOpenAnnotationRequest] = React.useState<{
    messageId: string
    annotationId: string
    mode: 'view' | 'edit'
    anchorX?: number
    anchorY?: number
    nonce: number
  } | null>(null)
  const followUpOpenNonceRef = React.useRef(0)

  // 用于 session 分支的导航
  const { navigate } = useNavigation()

  // 从 useTheme 获取 isDark,用于 overlay 主题
  // 这里会考虑强制深色模式的风光主题(如 Haze)
  const { isDark } = useTheme()

  // 注册为 focus zone - 当 zone 获得焦点时,聚焦 textarea
  // 用 isFocusedPanelRef 守卫,确保多面板布局下只有焦点面板会响应
  const { zoneRef, isFocused } = useFocusZone({
    zoneId: 'chat',
    enabled: isFocusedPanel,
    focusFirst: () => {
      if (isFocusedPanelRef.current) {
        textareaRef.current?.focus()
      }
    },
  })

  // 后台任务管理
  const { tasks: backgroundTasks, killTask } = useBackgroundTasks({
    sessionId: session?.id ?? ''
  })

  // TurnCard 展开状态 — 跨 session 切换持久化到 localStorage
  const {
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  } = useTurnCardExpansion(session?.id)


  // ============================================================================
  // 搜索高亮(来自 session 列表搜索)
  // ============================================================================
  // 用于导航的当前匹配索引(内部状态,通过 ref 暴露)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const turnRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  // 运行时注入 ::highlight() 样式,以避免 LightningCSS 构建告警
  // (优化器尚未把 ::highlight 识别为合法伪元素)
  React.useEffect(() => {
    const id = 'search-highlight-styles'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      ::highlight(search-passive) { background-color: rgb(253 224 71 / 0.3); color: inherit; }
      ::highlight(search-active) { background-color: rgb(253 224 71); color: rgb(0 0 0 / 0.9); }
    `
    document.head.appendChild(style)
  }, [])
  // 控制何时滚动到匹配项的标志
  // 仅在以下情况滚动:搜索激活时 session 变化,或用户点击导航
  const shouldScrollToMatchRef = React.useRef(false)
  const prevSessionIdForScrollRef = React.useRef<string | null>(null)

  // 使用来自 props 的外部搜索查询
  const searchQuery = externalSearchQuery || ''
  // 需要 2 个及以上字符才激活聊天内搜索(与 session 列表的 isSearchMode 对齐)
  const isSearchActive = searchQuery.trim().length >= 2

  // 当 zone 通过键盘获得焦点(Tab、Cmd+3、ArrowRight)时聚焦 textarea
  // 要求 isFocused 为 true - 遵循 zone 架构
  // 不会仅因 session 变化就自动聚焦(那样会从 SessionList 抢走焦点)
  // 使用 isSearchModeActive(prop)而非 isSearchActive(基于查询),以防止
  // 搜索打开但查询为空时的焦点抢占
  // 多面板布局下,只有焦点面板应自动聚焦其 textarea
  useEffect(() => {
    if (session && !isSearchModeActive && isFocused && isFocusedPanel) {
      textareaRef.current?.focus()
    }
  }, [session?.id, isFocused, isSearchModeActive, isFocusedPanel])

  useEffect(() => {
    let isMounted = true

    const loadSendMessageKey = async () => {
      if (!window.electronAPI) return

      try {
        const key = await window.electronAPI.getSendMessageKey()
        if (!isMounted) return
        setSendMessageKey(key ?? 'enter')
      } catch (error) {
        console.error('Failed to load send message key for follow-up view:', error)
      }
    }

    loadSendMessageKey()

    return () => {
      isMounted = false
    }
  }, [])

  // 当 session 或搜索查询变化时重置匹配状态
  useEffect(() => {
    const isSessionSwitch = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
    prevSessionIdForScrollRef.current = session?.id ?? null

    // 若搜索激活时切换了 session,则触发滚动到第一个匹配项
    if (isSessionSwitch && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }

    setCurrentMatchIndex(0)
  }, [session?.id, searchQuery, isSearchActive])

  // 统计子字符串出现次数的辅助函数
  const countOccurrences = useCallback((text: string, query: string): number => {
    const lowerText = text.toLowerCase()
    const lowerQuery = query.toLowerCase()
    let count = 0
    let pos = 0
    while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
      count++
      pos += lowerQuery.length
    }
    return count
  }, [])

  // 查找所有独立的匹配项(不仅是 turn)
  // 返回数组,每个匹配项都有唯一的 matchId
  const matchingOccurrences = useMemo(() => {
    if (!searchQuery.trim() || !session?.messages) return []
    const startTime = performance.now()
    const query = searchQuery.toLowerCase()
    const turns = groupMessagesByTurn(session.messages, { isSessionProcessing: session.isProcessing })
    const matches: { matchId: string; turnId: string; turnIndex: number; matchIndexInTurn: number }[] = []

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
      const turn = turns[turnIndex]
      let textContent = ''
      let turnId = ''

      // 使用 getTurnKey() 以在文本扫描与 DOM ref 之间保持 ID 一致
      turnId = getTurnKey(turn)

      if (turn.type === 'user') {
        const content = turn.message.content as unknown
        if (typeof content === 'string') {
          textContent = content
        } else if (Array.isArray(content)) {
          textContent = content
            .filter((block: { type?: string }) => block.type === 'text')
            .map((block: { text?: string }) => block.text || '')
            .join('\n')
        }
      } else if (turn.type === 'assistant') {
        if (turn.response?.text) {
          textContent = turn.response.text
        }
      } else if (turn.type === 'system') {
        textContent = turn.message.content
      }

      // 统计该 turn 文本内容中的出现次数
      const occurrenceCount = countOccurrences(textContent, query)
      for (let i = 0; i < occurrenceCount; i++) {
        matches.push({
          matchId: `${turnId}-match-${i}`,
          turnId,
          turnIndex,
          matchIndexInTurn: i,
        })
      }
    }
    return matches
  }, [searchQuery, session?.messages, session?.isProcessing, countOccurrences])

  // 搜索激活时自动展开分页,以展示所有匹配的 turn
  // 这样可确保匹配计数稳定,且所有匹配从一开始就可高亮
  useEffect(() => {
    if (!isSearchActive || matchingOccurrences.length === 0) return

    // 找到最早的匹配 turn 索引(用 reduce 以避免大数组上的 RangeError)
    const earliestMatchTurnIndex = matchingOccurrences.reduce(
      (min, m) => m.turnIndex < min ? m.turnIndex : min,
      matchingOccurrences[0]!.turnIndex
    )
    const totalTurns = groupMessagesByTurn(session?.messages || [], { isSessionProcessing: session?.isProcessing }).length

    // 计算需要展示多少个 turn 才能覆盖所有匹配
    // totalTurns - visibleTurnCount = startIndex,因此需要 visibleTurnCount = totalTurns - earliestMatchTurnIndex + 缓冲
    const requiredVisibleCount = totalTurns - earliestMatchTurnIndex + 5 // +5 作为上下文缓冲

    if (requiredVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(requiredVisibleCount)
    }
  }, [isSearchActive, matchingOccurrences, session?.messages, session?.isProcessing, visibleTurnCount])

  // 提取存在匹配的唯一 turn ID(用于高亮)
  const matchingTurnIds = useMemo(() => {
    const uniqueTurnIds = new Set(matchingOccurrences.map(m => m.turnId))
    return Array.from(uniqueTurnIds)
  }, [matchingOccurrences])

  // 借助 CSS Custom Highlight API,导航由逻辑匹配驱动 —— 无需 DOM 校验。
  const validMatches = matchingOccurrences

  // 仅当恰好有一个匹配时才自动滚动到匹配项
  // 多个匹配时:用户用 chevron 导航,以避免令人不适的滚动
  useEffect(() => {
    if (validMatches.length === 1 && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }
  }, [validMatches.length, isSearchActive])

  // 滚动到当前匹配的 turn
  // 仅当 shouldScrollToMatchRef 为 true 时滚动(单个匹配的自动滚动或导航按钮点击)
  useEffect(() => {
    if (!shouldScrollToMatchRef.current) return

    if (validMatches.length > 0 && currentMatchIndex < validMatches.length) {
      const matchData = validMatches[currentMatchIndex]
      const { turnId, turnIndex } = matchData
      const totalTurns = totalTurnCountRef.current

      // 检查匹配是否在可见范围之外
      const currentStartIndex = Math.max(0, totalTurns - visibleTurnCount)
      if (turnIndex < currentStartIndex) {
        const newVisibleCount = totalTurns - turnIndex + 5
        setVisibleTurnCount(newVisibleCount)
        return
      }

      // 将该 turn 滚动到视图中
      const turnEl = turnRefs.current.get(turnId)
      if (turnEl) {
        const rect = turnEl.getBoundingClientRect()
        const buffer = 128
        const isVisible = rect.top >= buffer && rect.bottom <= window.innerHeight - buffer
        if (!isVisible) {
          turnEl.scrollIntoView({ behavior: 'instant', block: 'center' })
        }
      }
      shouldScrollToMatchRef.current = false
    }
  }, [validMatches, currentMatchIndex, session?.id, visibleTurnCount])

  // ---------------------------------------------------------------------------
  // CSS Custom Highlight API — 非破坏式文本高亮
  // 在匹配文本上创建浏览器原生的高亮 range,无需修改 DOM 树。
  // 与 React 重新渲染及流式输出兼容。
  // 使用跨节点匹配:跨节点边界拼接文本,
  // 以查找跨多个 DOM 节点的匹配(例如 Shiki 拆分的 token)。
  // ---------------------------------------------------------------------------

  const MAX_HIGHLIGHT_RANGES = 5000
  // 存储计算好的 range,以便 active-match effect 重新设置样式时无需再次遍历 DOM
  const highlightRangesRef = React.useRef<Range[]>([])

  // Effect 1:当搜索/session/分页变化时遍历 DOM 并收集高亮 range
  useEffect(() => {
    const cssHighlights = getCSSHighlights()
    highlightRangesRef.current = []

    // 清除之前的高亮
    try {
      cssHighlights?.delete('search-passive')
      cssHighlights?.delete('search-active')
    } catch { /* API 不可用 — 无操作 */ }

    if (!searchQuery.trim() || !isSearchActive || !cssHighlights) return

    const query = searchQuery.toLowerCase()
    const matchingTurnIdSet = new Set(matchingTurnIds)
    if (matchingTurnIdSet.size === 0) return

    const rafId = requestAnimationFrame(() => {
      const allRanges: Range[] = []

      turnRefs.current.forEach((container, turnKey) => {
        if (allRanges.length >= MAX_HIGHLIGHT_RANGES) return
        if (!matchingTurnIdSet.has(turnKey)) return

        // 对于 assistant turn,将搜索范围收窄到响应内容根节点
        const searchRoot = container.querySelector('[data-search-root="response"]') || container

        // 收集所有合格的文本节点(不做查询过滤 —— 跨节点匹配需要)
        const walker = document.createTreeWalker(
          searchRoot,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement
              if (!parent) return NodeFilter.FILTER_REJECT
              const tag = parent.tagName.toLowerCase()
              if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT
              if (parent.closest('[data-search-exclude="true"]')) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            },
          }
        )

        // 为跨节点匹配构建拼接字符串与节点偏移映射
        const textNodes: Text[] = []
        let currentNode: Node | null
        while ((currentNode = walker.nextNode())) {
          textNodes.push(currentNode as Text)
        }
        if (textNodes.length === 0) return

        const nodeOffsets: { node: Text; start: number; end: number }[] = []
        let totalLength = 0
        for (const node of textNodes) {
          const text = node.textContent || ''
          nodeOffsets.push({ node, start: totalLength, end: totalLength + text.length })
          totalLength += text.length
        }
        const concatenated = textNodes.map(n => n.textContent || '').join('')
        const lowerConcatenated = concatenated.toLowerCase()

        // 在拼接字符串中查找所有匹配
        let searchPos = 0
        while (searchPos < lowerConcatenated.length && allRanges.length < MAX_HIGHLIGHT_RANGES) {
          const idx = lowerConcatenated.indexOf(query, searchPos)
          if (idx === -1) break
          const matchEnd = idx + query.length

          // 创建跨越该匹配的 Range(可能跨越节点边界)
          try {
            const range = new Range()
            let startSet = false

            for (const offset of nodeOffsets) {
              if (offset.end <= idx) continue
              if (offset.start >= matchEnd) break

              if (!startSet) {
                range.setStart(offset.node, idx - offset.start)
                startSet = true
              }
              range.setEnd(offset.node, Math.min(offset.end - offset.start, matchEnd - offset.start))
            }

            if (startSet) {
              allRanges.push(range)
            }
          } catch {
            // 若遍历过程中节点被移除,Range 创建可能失败
          }

          searchPos = matchEnd
        }
      })

      // 存储 range,供 active-match effect 使用
      highlightRangesRef.current = allRanges

      if (allRanges.length === 0 && matchingTurnIdSet.size > 0) {
        console.warn('[search-highlight] 0 ranges from', matchingTurnIdSet.size, 'matching turns — possible turn ID mismatch')
      }

      if (allRanges.length === 0) return

      try {
        // 初始将所有 range 应用为 passive —— active-match effect 会重新设置样式
        cssHighlights.set('search-passive', new Highlight(...allRanges))
      } catch {
        // Highlight API 调用失败 — 优雅降级
      }
    })

    return () => cancelAnimationFrame(rafId)
  }, [searchQuery, isSearchActive, matchingTurnIds, session?.id, visibleTurnCount])

  // Effect 2:当导航索引变化时更新 active/passive 高亮划分
  // 轻量级 —— 只是把已有的 Range 对象在两个 Highlight 实例之间重新分配
  useEffect(() => {
    const cssHighlights = getCSSHighlights()
    const allRanges = highlightRangesRef.current
    if (!cssHighlights || allRanges.length === 0) return

    try {
      const activeRange = allRanges[currentMatchIndex]
      if (activeRange) {
        const passiveRanges = allRanges.filter((_, i) => i !== currentMatchIndex)
        cssHighlights.set('search-passive', new Highlight(...passiveRanges))
        cssHighlights.set('search-active', new Highlight(activeRange))
      } else {
        cssHighlights.set('search-passive', new Highlight(...allRanges))
        cssHighlights.delete('search-active')
      }
    } catch { /* 优雅降级 */ }
  }, [currentMatchIndex])

  // 导航到下一个匹配(不循环 - 停在最后一个匹配)
  const goToNextMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // 不循环 - 停在最后一个匹配
      if (prev >= validMatches.length - 1) return prev
      shouldScrollToMatchRef.current = true
      return prev + 1
    })
  }, [validMatches])

  // 导航到上一个匹配(不循环 - 停在第一个匹配)
  const goToPrevMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // 不循环 - 停在第一个匹配
      if (prev <= 0) return prev
      shouldScrollToMatchRef.current = true
      return prev - 1
    })
  }, [validMatches])

  // 借助 CSS Highlight API,高亮是即时的 —— 没有稳定阶段
  const isHighlighting = false

  // 通过命令式句柄暴露导航(供 session 列表导航控件使用)
  React.useImperativeHandle(ref, () => ({
    goToNextMatch,
    goToPrevMatch,
    matchCount: validMatches.length,
    currentMatchIndex,
    isHighlighting,
  }), [goToNextMatch, goToPrevMatch, validMatches.length, currentMatchIndex])

  // 当匹配信息(计数、索引、高亮状态)变化时通知父级
  useEffect(() => {
    onMatchInfoChange?.({
      count: validMatches.length,
      index: currentMatchIndex,
      isHighlighting,
      sessionId: session?.id ?? null,
    })
  }, [validMatches.length, currentMatchIndex, isHighlighting, session?.id, onMatchInfoChange])

  // ============================================================================
  // Overlay 状态管理
  // ============================================================================

  // Overlay 状态 - 控制展示哪个 overlay(若有)
  const [overlayState, setOverlayState] = useState<OverlayState>(null)

  // Diff viewer 设置 - 挂载时从用户偏好加载,变化时持久化
  // 这些设置存储在 ~/.craft-agent/preferences.json(而非 localStorage)
  const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})

  // 挂载时从偏好加载 diff viewer 设置
  useEffect(() => {
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        if (prefs.diffViewer) {
          setDiffViewerSettings(prefs.diffViewer)
        }
      } catch {
        // 忽略解析错误,使用默认值
      }
    })
  }, [])

  // diff viewer 设置变化时持久化到偏好
  const handleDiffViewerSettingsChange = useCallback((settings: DiffViewerSettings) => {
    setDiffViewerSettings(settings)
    // 读取当前偏好,合并新设置后写回
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        prefs.diffViewer = settings
        prefs.updatedAt = Date.now()
        window.electronAPI.writePreferences(JSON.stringify(prefs, null, 2))
      } catch {
        // 若偏好格式损坏,则仅用 diffViewer 重新创建
        window.electronAPI.writePreferences(JSON.stringify({ diffViewer: settings, updatedAt: Date.now() }, null, 2))
      }
    })
  }, [])

  // 关闭 overlay 的处理函数
  const handleCloseOverlay = useCallback(() => {
    setOverlayState(null)
  }, [])

  // 为基于活动的 overlay 提取 overlay 卡片(Input/Output,可扩展)
  const overlayCards = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return []
    return extractOverlayCards(overlayState.activity)
  }, [overlayState])

  // 旧版仅输出型活动 overlay 的解析后输出数据
  const activityOutputOverlayData = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return null
    return extractOverlayData(overlayState.activity)
  }, [overlayState])

  // 堆叠的输入/输出卡片仅对 Bash 和 MCP 工具启用
  const useStackedActivityOverlay = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return false
    return isStackedActivityTool(overlayState.activity)
  }, [overlayState])

  // Pop-out 处理函数 - 在 overlay 中打开消息(只读 markdown)
  const handlePopOut = useCallback((message: Message) => {
    if (!session) return
    setOverlayState({
      type: 'markdown',
      content: message.content,
      title: 'Message Preview',
    })
  }, [session])

  // 用于滚动处理函数中追踪总 turn 数的 ref
  const totalTurnCountRef = React.useRef(0)

  // 最新消息的元数据(用于提交时的自动滚动)
  const messageCount = session?.messages.length ?? 0
  const lastMessage = messageCount > 0 ? session?.messages[messageCount - 1] : undefined
  const lastMessageId = lastMessage?.id
  const lastMessageRole = lastMessage?.role

  const pendingFollowUpAnnotations = useMemo<PendingFollowUpAnnotation[]>(() => {
    if (!session?.messages?.length) return []

    const pending: PendingFollowUpAnnotation[] = []

    for (const message of session.messages) {
      if (message.role !== 'assistant' && message.role !== 'plan') continue
      if (!message.annotations?.length) continue

      for (const annotation of message.annotations) {
        const note = getAnnotationNoteText(annotation)
        if (!note) continue
        if (isAnnotationFollowUpSent(annotation)) continue

        pending.push({
          messageId: message.id,
          annotationId: annotation.id,
          note,
          selectedText: extractAnnotationSelectedText(annotation, message.content),
          createdAt: annotation.updatedAt ?? annotation.createdAt,
          color: annotation.style?.color,
          meta: asRecord(annotation.meta) ?? undefined,
        })
      }
    }

    return pending.sort((a, b) => a.createdAt - b.createdAt)
  }, [session?.messages])

  const followUpInputItems = useMemo(() => {
    return pendingFollowUpAnnotations.map((followUp, idx) => ({
      id: `${followUp.messageId}:${followUp.annotationId}`,
      messageId: followUp.messageId,
      annotationId: followUp.annotationId,
      index: idx + 1,
      noteLabel: normalizeFollowUpText(followUp.note),
      selectedText: truncateForChipTooltip(followUp.selectedText, 260),
      color: followUp.color,
    }))
  }, [pendingFollowUpAnnotations])

  // 追踪滚动位置以切换粘底行为
  // - 用户向上滚动 → 取消粘底(停止自动滚动)
  // - 用户滚回底部 → 重新粘底(恢复自动滚动)
  // 同时处理滚动到顶部附近时加载更多 turn
  const handleScroll = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    const { scrollTop, scrollHeight, clientHeight } = viewport
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    // "在底部" 的检测阈值为 20px
    isStickToBottomRef.current = distanceFromBottom < 20

    // 滚动到顶部附近(100px 以内)时加载更多 turn
    if (scrollTop < 100) {
      setVisibleTurnCount(prev => {
        // 检查是否还有更多 turn 可加载
        const currentStartIndex = Math.max(0, totalTurnCountRef.current - prev)
        if (currentStartIndex <= 0) return prev // 已展示全部

        // 记住添加更多项之前的滚动高度
        const prevScrollHeight = viewport.scrollHeight

        // 在渲染后调度滚动位置调整
        requestAnimationFrame(() => {
          const newScrollHeight = viewport.scrollHeight
          viewport.scrollTop = newScrollHeight - prevScrollHeight + scrollTop
        })

        return prev + TURNS_PER_PAGE
      })
    }
  }, [])

  // 设置滚动事件监听
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 使用 ResizeObserver 对流式内容自动滚动
  // 初始滚动由 ScrollOnMount 处理(useLayoutEffect,在绘制之前)
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const isSessionSwitch = prevSessionIdRef.current !== session?.id
    prevSessionIdRef.current = session?.id ?? null

    // session 切换时:重置 UI 状态(滚动由 ScrollOnMount 处理)
    if (isSessionSwitch) {
      isStickToBottomRef.current = true
      setVisibleTurnCount(TURNS_PER_PAGE)
    }

    // 为流式输出做防抖滚动 - 等待布局稳定
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const resizeObserver = new ResizeObserver(() => {
      // 非焦点面板:始终瞬时滚动到底部(用户不会在阅读它们)
      if (!isFocusedPanelRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
        return
      }

      // 焦点面板:尊重粘底偏好
      if (!isStickToBottomRef.current) return

      // 清除待处理的滚动,等待布局稳定
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        // 若刚刚做过瞬时滚动(session 切换/懒加载),则跳过平滑滚动
        if (Date.now() < skipSmoothScrollUntilRef.current) return
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 200)
    })

    // 观察滚动内容容器(viewport 的第一个子元素)
    const content = viewport.firstElementChild
    if (content) {
      resizeObserver.observe(content)
    }

    return () => {
      resizeObserver.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [session?.id])

  // 提交时对新用户消息自动滚动。
  // 这与提交时的滚动互补,覆盖附件延迟乐观消息插入
  // (例如缩略图生成/调整大小)的情况。
  React.useEffect(() => {
    const currentSessionId = session?.id ?? null

    // session 切换时重置基线;交给 ScrollOnMount/session 切换逻辑处理。
    if (prevSessionIdForCommitScrollRef.current !== currentSessionId) {
      prevSessionIdForCommitScrollRef.current = currentSessionId
      prevLastMessageIdRef.current = lastMessageId ?? null
      prevMessageCountRef.current = messageCount
      return
    }

    const previousCount = prevMessageCountRef.current
    const previousLastId = prevLastMessageIdRef.current
    const messageActuallyChanged = !!lastMessageId && lastMessageId !== previousLastId
    const countIncreased = messageCount > previousCount

    // 在提前返回之前更新基线,以保持 ref 一致。
    prevLastMessageIdRef.current = lastMessageId ?? null
    prevMessageCountRef.current = messageCount

    if (!messageActuallyChanged || !countIncreased) return
    if (lastMessageRole !== 'user') return

    // 发送消息时应始终重新粘到底部。
    isStickToBottomRef.current = true

    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: isFocusedPanelRef.current ? 'smooth' : 'instant',
      })
    })
  }, [session?.id, messageCount, lastMessageId, lastMessageRole])

  // 处理来自 InputContainer 的消息提交
  // 若当前正在处理,后端会处理中断与排队
  const handleSubmit = (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => {
    const hasBaseMessage = message.trim().length > 0
    const followUpSection = formatFollowUpSection(pendingFollowUpAnnotations, {
      includeTopSeparator: hasBaseMessage,
    })
    const messageWithFollowUps = followUpSection.length > 0
      ? (hasBaseMessage ? `${message}\n\n${followUpSection}` : followUpSection)
      : message
    const normalizedMessage = normalizeFollowUpsMarkdown(messageWithFollowUps)

    // 用户发送消息时强制粘底
    isStickToBottomRef.current = true
    onSendMessage(normalizedMessage, attachments, skillSlugs)

    // 在 follow-up annotation 上持久化已发送标记,以便 TurnCard 区分
    // 已发送与待处理的 follow-up。若用户之后编辑 follow-up,TurnCard
    // 会清除这些标记,该 annotation 重新变为待处理。
    if (session && pendingFollowUpAnnotations.length > 0) {
      const sentAt = Date.now()
      void Promise.all(pendingFollowUpAnnotations.map((followUp) => {
        const currentMeta = followUp.meta ?? {}
        const currentFollowUpMeta = asRecord(currentMeta.followUp) ?? {}

        return window.electronAPI.sessionCommand(session.id, {
          type: 'updateAnnotation',
          messageId: followUp.messageId,
          annotationId: followUp.annotationId,
          patch: {
            meta: {
              ...currentMeta,
              followUp: {
                ...currentFollowUpMeta,
                text: followUp.note,
                lastSentAt: sentAt,
                lastSentText: followUp.note,
              },
            },
          },
        })
      })).catch((error) => {
        console.error('[ChatDisplay] Failed to mark follow-up annotations as sent:', error)
      })
    }

    // 发送后立即滚动到底部 - 使用 requestAnimationFrame
    // 以确保 DOM 已更新出新消息
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }

  const handleSaveAndSendFollowUp = useCallback((_target: {
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  }) => {
    if (!session) return

    if (isInputDisabled || disableSend || connectionUnavailable) {
      toast.error(t('toast.cannotSendRightNow'), {
        description: 'Sending is currently disabled for this session.',
      })
      return
    }

    // 模拟在 Save 完成后按下输入框中的 Send。
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('craft:submit-input', {
        detail: { sessionId: session.id },
      }))
    }, 0)
  }, [session, isInputDisabled, disableSend, connectionUnavailable])

  // 处理来自 InputContainer 的停止请求
  // 重定向(发送新消息)时 silent=true;用户点击 Stop 按钮时 silent=false
  const handleStop = (silent = false) => {
    if (!session?.isProcessing) return

    // 显式 Stop(非重定向/新消息发送):将进行中的 prompt 放回输入框,
    // 以便用户调整后重发。追加到任何已有的草稿后。
    // 排除 isQueued 消息 —— 这些由后端 `restore_input` effect(App.tsx)
    // 单独恢复,否则在这里会重复。
    if (!silent) {
      const lastUserMsg = [...session.messages].reverse().find(m => m.role === 'user' && !m.isQueued)
      const restoredText = coerceInputText(lastUserMsg?.content)
      if (restoredText) {
        onInputChange?.(appendRestoredInput(inputValue, restoredText))
      }
    }

    window.electronAPI.cancelProcessing(session.id, silent).catch(error => {
      console.error('[ChatDisplay] Failed to cancel processing:', error)
    })
  }

  // 输入高度动画期间逐帧的滚动补偿
  // 仅在用户"粘底"时补偿 - 否则让其自行控制滚动位置
  const handleAnimatedHeightChange = React.useCallback((delta: number) => {
    if (!isStickToBottomRef.current) return
    const viewport = scrollViewportRef.current
    if (!viewport) return
    // 调整滚动以保持相对内容的位置
    viewport.scrollTop += delta
  }, [])

  // 处理结构化输入响应(权限与凭证)
  const handleStructuredResponse = (response: StructuredResponse) => {
    if ((response.type === 'permission' || response.type === 'admin_approval') && pendingPermission && onRespondToPermission) {
      if (response.type === 'permission') {
        const permResponse = response as PermissionResponse
        onRespondToPermission(
          pendingPermission.sessionId,
          pendingPermission.requestId,
          permResponse.allowed,
          permResponse.alwaysAllow
        )
        return
      }

      const adminResponse = response as AdminApprovalResponse
      onRespondToPermission(
        pendingPermission.sessionId,
        pendingPermission.requestId,
        adminResponse.approved,
        false,
        { rememberForMinutes: adminResponse.rememberForMinutes }
      )
    } else if (response.type === 'credential' && pendingCredential && onRespondToCredential) {
      const credResponse = response as CredentialResponse
      onRespondToCredential(
        pendingCredential.sessionId,
        pendingCredential.requestId,
        credResponse
      )
    }
  }

  // 从待处理请求构建结构化输入状态(权限优先)
  const structuredInput: StructuredInputState | undefined = React.useMemo(() => {
    if (pendingPermission) {
      if (pendingPermission.type === 'admin_approval') {
        return {
          type: 'admin_approval',
          data: {
            appName: pendingPermission.appName || pendingPermission.toolName || 'System action',
            reason: pendingPermission.reason || pendingPermission.description,
            impact: pendingPermission.impact,
            command: pendingPermission.command || '',
            requiresSystemPrompt: pendingPermission.requiresSystemPrompt ?? true,
            rememberForMinutes: pendingPermission.rememberForMinutes ?? 10,
          },
        }
      }
      return { type: 'permission', data: pendingPermission }
    }
    if (pendingCredential) {
      return { type: 'credential', data: pendingCredential }
    }
    return undefined
  }, [pendingPermission, pendingCredential])

  // 对 turn 分组做 memo 化 - 避免每次渲染/按键都做 O(n) 迭代
  const allTurns = React.useMemo(() => {
    if (!session) return []
    return groupMessagesByTurn(session.messages, { isSessionProcessing: session.isProcessing })
  }, [session?.messages, session?.isProcessing])

  // 保持 ref 同步,供滚动处理函数使用
  totalTurnCountRef.current = allTurns.length

  // 反向分页:仅渲染最后 N 个 turn 以实现快速初始渲染
  const startIndex = Math.max(0, allTurns.length - visibleTurnCount)
  const turns = allTurns.slice(startIndex)
  const hasMoreAbove = startIndex > 0

  const assistantTurnIndexByMessageId = useMemo(() => {
    const map = new Map<string, number>()
    allTurns.forEach((turn, index) => {
      if (turn.type !== 'assistant') return
      const messageId = turn.response?.messageId
      if (messageId) map.set(messageId, index)
    })
    return map
  }, [allTurns])

  const scrollToFollowUpTurn = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex == null) return

    const ensureVisibleCount = allTurns.length - targetTurnIndex

    const scrollToTurn = () => {
      const targetTurn = allTurns[targetTurnIndex]
      if (!targetTurn) return false

      const turnKey = getTurnKey(targetTurn)
      const turnContainer = turnRefs.current.get(turnKey)
      if (!turnContainer) return false

      turnContainer.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return true
    }

    if (ensureVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(ensureVisibleCount)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scrollToTurn()) {
            setTimeout(() => {
              void scrollToTurn()
            }, 80)
          }
        })
      })
      return
    }

    if (!scrollToTurn()) {
      requestAnimationFrame(() => {
        void scrollToTurn()
      })
    }
  }, [assistantTurnIndexByMessageId, allTurns, visibleTurnCount])

  const handleFollowUpChipClick = useCallback((item: {
    messageId: string
    annotationId: string
  }, anchor?: { x: number; y: number }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex != null) {
      const ensureVisibleCount = allTurns.length - targetTurnIndex
      if (ensureVisibleCount > visibleTurnCount) {
        setVisibleTurnCount(ensureVisibleCount)
      }
    }

    followUpOpenNonceRef.current += 1
    setOpenAnnotationRequest({
      messageId: item.messageId,
      annotationId: item.annotationId,
      mode: 'view',
      anchorX: anchor?.x,
      anchorY: anchor?.y,
      nonce: followUpOpenNonceRef.current,
    })
  }, [assistantTurnIndexByMessageId, allTurns, visibleTurnCount])

  const handleFollowUpIndexClick = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    scrollToFollowUpTurn(item)
  }, [scrollToFollowUpTurn])

  // 计算是否应跳过滚动到底部(session 切换时若搜索激活则跳过)
  // 渲染时 prevSessionIdForScrollRef 仍持有旧的 session ID,因此可以检测到切换
  const isSessionSwitchForScroll = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
  const skipScrollToBottom = isSessionSwitchForScroll && isSearchActive
  const hasUnrenderedLoadedMessages = !messagesLoading
    && turns.length === 0
    && ((session?.messages?.length ?? 0) > 0 || (session?.messageCount ?? 0) > 0)

  return (
    <div ref={zoneRef} className="flex h-full flex-col min-w-0" data-focus-zone="chat">
      {session ? (
        <div className="flex flex-1 flex-col min-h-0 min-w-0 relative">
          {/* 内容层 */}
          <div className="flex flex-1 flex-col min-h-0 min-w-0 relative z-10">
          {/* === 消息区:可滚动的消息气泡列表 === */}
          <div className="relative flex-1 min-h-0">
            {/* 遮罩包裹层 - 在透明/图片背景上对顶部和底部内容做渐隐 */}
            <div
              className="h-full"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
              }}
            >
              <ScrollArea className="h-full min-w-0" viewportRef={scrollViewportRef}>
              <div className={cn(
                CHAT_LAYOUT.maxWidth,
                "mx-auto min-w-0",
                compactMode ? "px-3 py-4 space-y-2" : [CHAT_LAYOUT.containerPadding, CHAT_LAYOUT.messageSpacing]
              )}>
                {/* Session 级 AnimatePresence:防止切换 session 时的布局跳动 */}
                <AnimatePresence mode={compactMode ? "sync" : "wait"} initial={false}>
                  <motion.div
                    key={compactMode ? 'compact-session' : session?.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                  >
                    {/* 加载/内容 AnimatePresence:sync 模式避免过期的加载退出遮盖就绪内容 */}
                    <AnimatePresence mode="sync" initial={false}>
                    {messagesLoading ? (
                      /* 加载状态:消息懒加载期间展示 spinner */
                      <motion.div
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={compactMode ? { duration: 0 } : { duration: 0.1 }}
                        className="flex items-center justify-center h-64"
                      >
                        <Spinner className="text-foreground/30" />
                      </motion.div>
                    ) : messagesLoadError ? (
                      <motion.div
                        key="load-error"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={compactMode ? { duration: 0 } : { duration: 0.1 }}
                        className="flex items-center justify-center h-64 px-4"
                      >
                        <div
                          className="max-w-sm rounded-[8px] border border-destructive/20 px-4 py-3 text-center shadow-tinted"
                          style={{
                            backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)',
                            '--shadow-color': 'var(--destructive-rgb)',
                          } as React.CSSProperties}
                        >
                          <AlertTriangle className="mx-auto mb-2 h-4 w-4 text-destructive/70" />
                          <div className="text-sm font-medium text-destructive">{t("chat.failedToLoadConversation")}</div>
                          <p className="mt-1 break-words text-xs text-destructive/70">{messagesLoadError}</p>
                          {onRetryMessagesLoad && (
                            <button
                              type="button"
                              onClick={onRetryMessagesLoad}
                              disabled={messagesRetrying}
                              className="mt-3 rounded border border-destructive/20 px-2 py-0.5 text-xs text-destructive/70 transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {messagesRetrying ? t("common.retrying") : t("common.retry")}
                            </button>
                          )}
                        </div>
                      </motion.div>
                    ) : (
                    /* 基于 turn 的消息展示 - 已 memo 化以避免每次渲染都重新分组 */
                    /* AnimatePresence 负责从加载状态过渡时的淡入动画 */
                    <motion.div
                      key={compactMode ? 'loaded-compact' : `loaded-${session?.id}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                    >
                  {/* 绘制前滚动到底部 - 通过 useLayoutEffect 触发 */}
                  {/* session 切换时若搜索激活则跳过 - 改为滚动到第一个匹配 */}
                  <ScrollOnMount
                    targetRef={messagesEndRef}
                    skip={skipScrollToBottom}
                    onScroll={() => {
                      skipSmoothScrollUntilRef.current = Date.now() + 500
                    }}
                  />
                  {/* 紧凑模式的空状态 - 居中于整个 popover 的引导式对话提示 */}
                  {compactMode && turns.length === 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center select-none gap-1 pointer-events-none">
                      <span className="text-sm text-muted-foreground">{t("editPopover.whatToChange")}</span>
                      <span className="text-xs text-muted-foreground/50">{t("editPopover.justDescribe")}</span>
                    </div>
                  )}
                  {!compactMode && hasUnrenderedLoadedMessages && (
                    <div className="flex h-64 items-center justify-center px-4 text-center">
                      <div className="max-w-sm rounded-[8px] border border-border/50 bg-foreground/[0.03] px-4 py-3">
                        <CircleAlert className="mx-auto mb-2 h-4 w-4 text-foreground/50" />
                        <div className="text-sm font-medium text-foreground/70">Conversation loaded, but no renderable messages were found.</div>
                        <p className="mt-1 text-xs text-foreground/50">Try reloading the session. If this persists, the message history may contain an unsupported format.</p>
                      </div>
                    </div>
                  )}
                  {/* 加载更多指示器 - 存在更早消息时展示 */}
                  {hasMoreAbove && (
                    <div className="text-center text-muted-foreground/60 text-xs py-3 select-none">
                      ↑ {t('chat.scrollUpForEarlier', { count: startIndex })}
                    </div>
                  )}
                  {turns.map((turn, index) => {
                    // 计算 turn key 并检查是否为搜索匹配
                    const turnKey = getTurnKey(turn)
                    const isCurrentMatch = isSearchActive && matchingTurnIds[currentMatchIndex] === turnKey
                    const isAnyMatch = isSearchActive && matchingTurnIds.includes(turnKey)

                    // User turn - 用 MemoizedMessageBubble 渲染
                    // 额外的 padding 用于与 AI 响应形成视觉分隔
                    if (turn.type === 'user') {
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            compactMode ? "pt-2 pb-1" : CHAT_LAYOUT.userMessagePadding,
                            "rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                            compactMode={compactMode}
                          />
                        </div>
                      )
                    }

                    // System turn(error、status、info、warning)- 用 MemoizedMessageBubble 渲染
                    if (turn.type === 'system') {
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            "rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                            onRetry={turn.message.role === 'error' ? () => {
                              const msgs = session?.messages
                              if (!msgs) return
                              const errorIdx = msgs.findIndex(m => m.id === turn.message.id)
                              const lastUserMsg = msgs.slice(0, errorIdx).findLast(m => m.role === 'user')
                              if (lastUserMsg) {
                                onSendMessage(lastUserMsg.content)
                              }
                            } : undefined}
                          />
                        </div>
                      )
                    }

                    // Auth-request turn - 渲染内联的 auth UI
                    // mt-2 与 ResponseCard 间距一致,以保持视觉一致
                    if (turn.type === 'auth-request') {
                      // 仅当其后没有 user 消息时才可交互
                      const isAuthInteractive = !turns.slice(index + 1).some(t => t.type === 'user')
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            "mt-2 rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedAuthRequestCard
                            message={turn.message}
                            sessionId={session.id}
                            onRespondToCredential={onRespondToCredential}
                            isInteractive={isAuthInteractive}
                          />
                        </div>
                      )
                    }

                    // 检查这是否是最后一个响应(用于 Accept Plan 按钮的可见性)
                    const isLastResponse = index === turns.length - 1 || !turns.slice(index + 1).some(t => t.type === 'user')

                    // Assistant turn - 用 TurnCard 渲染(带缓冲的流式输出)
                    const assistantUiKey = getAssistantTurnUiKey(turn, index)
                    return (
                      <div
                        key={turnKey}
                        ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                        className={cn(
                          "pt-2",
                          "rounded-lg transition-all duration-200",
                          isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                          isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                        )}
                      >
                      <TurnCard
                        sessionId={session.id}
                        sessionFolderPath={session.sessionFolderPath}
                        hasActiveFollowUpAnnotations={pendingFollowUpAnnotations.length > 0}
                        turnId={turn.turnId}
                        activities={turn.activities}
                        response={turn.response}
                        intent={turn.intent}
                        isStreaming={turn.isStreaming}
                        isComplete={turn.isComplete}
                        isExpanded={expandedTurns.has(assistantUiKey)}
                        onExpandedChange={(expanded) => toggleTurn(assistantUiKey, expanded)}
                        expandedActivityGroups={expandedActivityGroups}
                        onExpandedActivityGroupsChange={setExpandedActivityGroups}
                        todos={turn.todos}
                        onOpenFile={onOpenFile}
                        onOpenUrl={onOpenUrl}
                        isLastResponse={isLastResponse}
                        compactMode={compactMode}
                        sendMessageKey={sendMessageKey}
                        openAnnotationRequest={openAnnotationRequest}
                        onBranch={session?.supportsBranching ? async (messageId: string, options?: { newPanel?: boolean }) => {
                          if (!session) return
                          try {
                            const child = await appShellContext.onCreateSession(
                              session.workspaceId,
                              {
                                branchFromMessageId: messageId,
                                branchFromSessionId: session.id,
                                name: `Branch of ${session.name || 'Untitled'}`,
                                // 通过继承父 session 的设置,使分支保持在同一 backend/provider 上。
                                llmConnection: session.llmConnection,
                                model: session.model,
                                permissionMode: session.permissionMode,
                                workingDirectory: session.workingDirectory,
                                enabledSourceSlugs: session.enabledSourceSlugs,
                              }
                            )
                            navigate(routes.view.allSessions(child.id), { newPanel: resolveBranchNewPanelOption(options) })
                          } catch (error) {
                            const rawMessage = error instanceof Error ? error.message : 'Failed to create branch'
                            const message = rawMessage.includes('source and target providers must match')
                              || rawMessage.includes('same provider/backend')
                              ? 'Branching is only supported within the same provider/backend. Switch this panel connection and try again.'
                              : rawMessage
                            toast.error(t('toast.couldNotCreateBranch'), { description: message })
                          }
                        } : undefined}
                        onAddAnnotation={async (messageId, annotation) => {
                          if (!session) return
                          try {
                            await window.electronAPI.sessionCommand(session.id, {
                              type: 'addAnnotation',
                              messageId,
                              annotation,
                            })
                          } catch (error) {
                            toast.error(t('toast.couldNotSaveHighlight'), {
                              description: error instanceof Error ? error.message : 'Unknown error',
                            })
                            throw error
                          }
                        }}
                        onRemoveAnnotation={async (messageId, annotationId) => {
                          if (!session) return
                          try {
                            await window.electronAPI.sessionCommand(session.id, {
                              type: 'removeAnnotation',
                              messageId,
                              annotationId,
                            })
                          } catch (error) {
                            toast.error(t('toast.couldNotRemoveHighlight'), {
                              description: error instanceof Error ? error.message : 'Unknown error',
                            })
                          }
                        }}
                        onUpdateAnnotation={async (messageId, annotationId, patch) => {
                          if (!session) return
                          try {
                            await window.electronAPI.sessionCommand(session.id, {
                              type: 'updateAnnotation',
                              messageId,
                              annotationId,
                              patch,
                            })
                          } catch (error) {
                            toast.error(t('toast.couldNotUpdateHighlight'), {
                              description: error instanceof Error ? error.message : 'Unknown error',
                            })
                            throw error
                          }
                        }}
                        onSaveAndSendFollowUp={handleSaveAndSendFollowUp}
                        onAcceptPlan={() => {
                          const planMessage = session?.messages.findLast(m => m.role === 'plan')
                          const planPath = planMessage?.planPath

                          window.dispatchEvent(new CustomEvent('craft:approve-plan', {
                            detail: {
                              sessionId: session?.id,
                              planPath,
                              includeDraftInput: true,
                              source: 'plan-card',
                            },
                          }))
                        }}
                        onAcceptPlanWithCompact={() => {
                          const planMessage = session?.messages.findLast(m => m.role === 'plan')
                          const planPath = planMessage?.planPath

                          window.dispatchEvent(new CustomEvent('craft:approve-plan-with-compact', {
                            detail: {
                              sessionId: session?.id,
                              planPath,
                              includeDraftInput: true,
                              source: 'plan-card',
                            },
                          }))
                        }}
                        onPopOut={(text) => {
                          // 在 code viewer 中打开原始 markdown 源码
                          setOverlayState({
                            type: 'markdown',
                            content: text,
                            title: 'Response Preview',
                            forceCodeView: true,
                          })
                        }}
                        onOpenDetails={() => {
                          // 在 markdown overlay 中打开 turn 详情
                          const markdown = formatTurnAsMarkdown(turn)
                          setOverlayState({
                            type: 'markdown',
                            content: markdown,
                            title: 'Turn Details',
                          })
                        }}
                        onOpenActivityDetails={(activity) => {
                          // 对 .md/.txt 的 Write 工具 → Document overlay(渲染后的 markdown),
                          // 而非 multi-diff,因为这些文件更适合作为格式化文档查看
                          const isDocumentWrite = activity.toolName === 'Write' && (() => {
                            const actInput = activity.toolInput as Record<string, unknown> | undefined
                            const fp = (actInput?.file_path as string) || ''
                            const ext = fp.split('.').pop()?.toLowerCase()
                            return ext === 'md' || ext === 'txt'
                          })()

                          // Edit/Write 工具 → 多文件 diff overlay(未分组,聚焦于本次改动)
                          // 例外:对 .md/.txt 文件的 Write 改为走 document overlay
                          if ((activity.toolName === 'Edit' || activity.toolName === 'Write') && !isDocumentWrite) {
                            const changes = collectFileChangesFromActivities(turn.activities)
                            if (changes.length > 0) {
                              setOverlayState({
                                type: 'multi-diff',
                                changes,
                                consolidated: false, // 未分组模式 - 展示单条改动
                                focusedChangeId: getFirstFileChangeIdForActivity(activity.id, changes),
                              })
                            }
                          } else {
                            // 其他所有工具 → 打开通用的活动卡片 overlay(Input/Output)
                            setOverlayState({ type: 'activity', activity })
                          }
                        }}
                        hasEditOrWriteActivities={turn.activities.some(a =>
                          a.toolName === 'Edit' || a.toolName === 'Write'
                        )}
                        onOpenMultiFileDiff={() => {
                          const changes = collectFileChangesFromActivities(turn.activities)
                          if (changes.length > 0) {
                            setOverlayState({
                              type: 'multi-diff',
                              changes,
                              consolidated: true, // 合并模式 - 按文件分组
                            })
                          }
                        }}
                      />
                      </div>
                    )
                  })}
                    </motion.div>
                    )}
                    </AnimatePresence>
                  </motion.div>
                </AnimatePresence>
                {/* 处理指示器 - 处理期间始终可见 */}
                {session.isProcessing && (() => {
                  // 查找最后一条 user 消息的时间戳,以获得准确的已耗时
                  const lastUserMsg = [...session.messages].reverse().find(m => m.role === 'user')
                  return (
                    <ProcessingIndicator
                      startTime={lastUserMsg?.timestamp}
                      statusMessage={session.currentStatus?.message}
                    />
                  )
                })()}
                {/* 滚动锚点:用于自动滚动到底部 */}
                <div ref={messagesEndRef} />
              </div>
              </ScrollArea>
            </div>
          </div>

          {/* === 输入容器:FreeForm 或 Structured 输入 === */}
          <ChatInputZone
            compactMode={compactMode}
            permissionMode={permissionMode}
            onPermissionModeChange={onPermissionModeChange}
            tasks={backgroundTasks}
            sessionId={session.id}
            sessionFolderPath={sessionFolderPath}
            onKillTask={(taskId) => killTask(taskId, backgroundTasks.find(t => t.id === taskId)?.type === 'shell' ? 'shell' : 'agent')}
            onInsertMessage={onInputChange}
            sessionLabels={session.labels}
            labels={labels}
            onLabelsChange={onLabelsChange}
            sessionStatuses={sessionStatuses}
            currentSessionStatus={session.sessionStatus || 'todo'}
            onSessionStatusChange={onSessionStatusChange}
            inputProps={{
              placeholder,
              disabled: isInputDisabled,
              isProcessing: session.isProcessing,
              onAnimatedHeightChange: handleAnimatedHeightChange,
              onSubmit: handleSubmit,
              onStop: handleStop,
              textareaRef,
              currentModel,
              onModelChange,
              thinkingLevel,
              onThinkingLevelChange,
              enabledModes,
              enableCompactModelPicker,
              structuredInput,
              onStructuredResponse: handleStructuredResponse,
              inputValue,
              onInputChange,
              attachmentsValue,
              onAttachmentsChange,
              sources,
              enabledSourceSlugs: session.enabledSourceSlugs,
              onSourcesChange,
              skills,
              workspaceId,
              workingDirectory,
              onWorkingDirectoryChange,
              disableSend: disableSend || connectionUnavailable,
              connectionUnavailable,
              isEmptySession: session.messages.length === 0,
              currentConnection: session.llmConnection,
              onConnectionChange,
              contextStatus: {
                isCompacting: session.currentStatus?.statusType === 'compacting',
                inputTokens: session.tokenUsage?.inputTokens,
                contextWindow: session.tokenUsage?.contextWindow,
              },
              followUpItems: followUpInputItems,
              onFollowUpClick: handleFollowUpChipClick,
              onFollowUpIndexClick: handleFollowUpIndexClick,
            }}
          />
          </div>
        </div>
      ) : null}

      {/* ================================================================== */}
      {/* 预览 Overlay - 渲染在主聊天流程之外                               */}
      {/* ================================================================== */}

      {/* 活动详情 overlay */}
      {overlayState?.type === 'activity' && useStackedActivityOverlay && (
        <ActivityCardsOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          cards={overlayCards}
          title={overlayState.activity.displayName || overlayState.activity.toolName || 'Activity'}
          theme={isDark ? 'dark' : 'light'}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
        />
      )}

      {/* 旧版仅输出型活动 overlay,用于非 bash/非 mcp 工具 */}
      {overlayState?.type === 'activity' && !useStackedActivityOverlay && activityOutputOverlayData && (
        activityOutputOverlayData.type === 'code' ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            filePath={activityOutputOverlayData.filePath}
            mode={activityOutputOverlayData.mode}
            startLine={activityOutputOverlayData.startLine}
            totalLines={activityOutputOverlayData.totalLines}
            numLines={activityOutputOverlayData.numLines}
            command={activityOutputOverlayData.command}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'terminal' ? (
          <TerminalPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            command={activityOutputOverlayData.command}
            output={activityOutputOverlayData.output}
            exitCode={activityOutputOverlayData.exitCode}
            toolType={activityOutputOverlayData.toolType}
            description={activityOutputOverlayData.description}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'json' ? (
          <JSONPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            data={activityOutputOverlayData.data}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'document' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            filePath={activityOutputOverlayData.filePath}
            typeBadge={{
              icon: Info,
              label: activityOutputOverlayData.toolName,
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : detectLanguage(activityOutputOverlayData.content) === 'markdown' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            typeBadge={{
              icon: Info,
              label: overlayState.activity.displayName || overlayState.activity.toolName || 'Activity',
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : (
          <GenericOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        )
      )}

      {/* 多文件 diff 预览 overlay(Edit/Write 工具) */}
      {overlayState?.type === 'multi-diff' && (
        <MultiDiffPreviewOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          changes={overlayState.changes}
          consolidated={overlayState.consolidated}
          focusedChangeId={overlayState.focusedChangeId}
          theme={isDark ? 'dark' : 'light'}
          diffViewerSettings={diffViewerSettings}
          onDiffViewerSettingsChange={handleDiffViewerSettingsChange}
        />
      )}

      {/* Markdown 预览 overlay(弹出、turn 详情) */}
      {/* forceCodeView:在 code viewer 中展示原始 markdown 源码(用于 "View as Markdown" 按钮) */}
      {/* 否则:渲染格式化后的 markdown(用于 turn 详情等) */}
      {overlayState?.type === 'markdown' && (
        overlayState.forceCodeView ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            filePath="response.md"
            language="markdown"
            mode="read"
            theme={isDark ? 'dark' : 'light'}
          />
        ) : (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
          />
        )
      )}
    </div>
  )
})

/**
 * MessageBubble - 根据消息角色渲染单条消息
 *
 * 消息角色与样式:
 * - user:      右对齐,蓝色(bg-foreground),白色文字
 * - assistant: 左对齐,灰色(bg-muted),渲染 markdown 并带可点击链接
 * - error:     左对齐,红色边框/背景,警告图标 + 错误消息
 * - status:    居中的胶囊徽标,带脉冲点(例如 t("chat.processing.thinking"))
 *
 * 注:Tool 消息由 TurnCard 渲染,而非 MessageBubble
 */
interface MessageBubbleProps {
  message: Message
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  sessionId?: string
  /**
   * assistant 消息的 markdown 渲染模式
   * @default 'minimal'
   */
  renderMode?: RenderMode
  /**
   * 将消息弹出到独立窗口的回调
   */
  onPopOut?: (message: Message) => void
  /** 紧凑模式 - 为 popover 嵌入缩减 padding */
  compactMode?: boolean
  /** 重新发送错误前那条 user 消息的回调 */
  onRetry?: () => void
}

/**
 * ErrorMessage - 错误消息的独立组件,以便使用 useState hook
 */
function ErrorMessage({ message, onOpenUrl, sessionId, onRetry }: { message: Message; onOpenUrl?: (url: string) => void; sessionId?: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  const hasDetails = (message.errorDetails && message.errorDetails.length > 0) || message.errorOriginal
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const actions = message.errorActions?.filter(a => {
    if (a.action === 'open_url') return !!a.url && !!onOpenUrl
    return true
  })

  return (
    <div className="flex justify-start mt-4">
      {/* 柔和背景(3% 不透明度)+ 着色阴影,让错误外观更柔和 */}
      <div
        className="max-w-[80%] shadow-tinted rounded-[8px] pl-5 pr-4 pt-2 pb-2.5 break-words"
        style={{
          backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)',
          '--shadow-color': 'var(--destructive-rgb)',
        } as React.CSSProperties}
      >
        <div className="text-xs text-destructive/50 mb-0.5 font-semibold">
          {message.errorTitle || t('common.error')}
        </div>
        <p className="text-sm text-destructive">{message.content}</p>

        {/* 动作按钮 */}
        {actions && actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <button
                key={action.key}
                onClick={() => {
                  handleErrorMessageAction(action, {
                    sessionId,
                    onOpenUrl,
                    onRetry,
                  })
                }}
                className="text-xs px-2 py-0.5 rounded border border-destructive/20 text-destructive/70 hover:text-destructive hover:border-destructive/40 transition-colors"
              >
                {action.label}{action.action === 'open_url' ? ' ↗' : ''}
              </button>
            ))}
          </div>
        )}

        {/* 可折叠的详情切换 */}
        {hasDetails && (
          <div className="mt-2">
            <button
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="flex items-center gap-1 text-xs text-destructive/70 hover:text-destructive transition-colors"
            >
              {detailsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <span>{detailsOpen ? t('chat.hideTechnicalDetails') : t('chat.showTechnicalDetails')}</span>
            </button>

            <AnimatedCollapsibleContent isOpen={detailsOpen} className="overflow-hidden">
              <div className="mt-2 pt-2 border-t border-destructive/20 text-xs text-destructive/60 font-mono space-y-0.5">
                {message.errorDetails?.map((detail, i) => (
                  <div key={i}>{detail}</div>
                ))}
                {message.errorOriginal && !message.errorDetails?.some(d => d.includes('Raw error:')) && (
                  <div className="mt-1">Raw: {message.errorOriginal.slice(0, 200)}{message.errorOriginal.length > 200 ? '...' : ''}</div>
                )}
              </div>
            </AnimatedCollapsibleContent>
          </div>
        )}
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  onOpenFile,
  onOpenUrl,
  sessionId,
  renderMode = 'minimal',
  onPopOut,
  compactMode,
  onRetry,
}: MessageBubbleProps) {
  const { t } = useTranslation()

  // === USER 消息:右对齐气泡,附件在上方 ===
  if (message.role === 'user') {
    return (
      <UserMessageBubble
        content={message.content}
        attachments={message.attachments}
        badges={message.badges}
        isPending={message.isPending}
        isQueued={message.isQueued}
        onUrlClick={onOpenUrl}
        onFileClick={onOpenFile}
        compactMode={compactMode}
      />
    )
  }

  // === ASSISTANT 消息:左对齐灰色气泡,带 markdown 渲染 ===
  if (message.role === 'assistant') {
    return (
      <div className="flex justify-start group">
        <div className="relative max-w-[90%] bg-background shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0 select-text">
          {/* Pop-out 按钮 - 悬停时可见 */}
          {onPopOut && !message.isStreaming && (
            <button
              onClick={() => onPopOut(message)}
              data-touch-reveal="true"
              className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/5"
              title={t("sidebarMenu.openInNewWindow")}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-foreground" />
            </button>
          )}
          {/* 流式输出期间使用 StreamingMarkdown 以获得块级 memo 化 */}
          {message.isStreaming ? (
            <StreamingMarkdown
              content={message.content}
              isStreaming={true}
              mode={renderMode}
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            />
          ) : (
            <CollapsibleMarkdownProvider>
              <Markdown
                mode={renderMode}
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
                id={message.id}
                className="text-sm"
                collapsible
              >
                {message.content}
              </Markdown>
            </CollapsibleMarkdownProvider>
          )}
        </div>
      </div>
    )
  }

  // === ERROR 消息:红色边框气泡,带警告图标与可折叠详情 ===
  if (message.role === 'error') {
    return <ErrorMessage message={message} onOpenUrl={onOpenUrl} sessionId={sessionId} onRetry={onRetry} />
  }

  // === STATUS 消息:与 ProcessingIndicator 布局一致以保持视觉连贯 ===
  if (message.role === 'status') {
    return (
      <div className="flex items-center gap-2 px-3 py-1 -mb-1 text-[13px] text-muted-foreground">
        {/* Spinner 位于与 TurnCard chevron 相同的位置 */}
        <div className="w-3 h-3 flex items-center justify-center shrink-0">
          <Spinner className="text-[10px]" />
        </div>
        <span>{message.content}</span>
      </div>
    )
  }

  // === INFO 消息:图标与颜色依据 level 决定 ===
  if (message.role === 'info') {
    // 压缩完成消息 - 渲染为带居中标签的水平分隔线
    // 重载后仍保留,以标示上下文被压缩的位置
    if (message.statusType === 'compaction_complete') {
      return (
        <div className="flex items-center gap-3 my-12 px-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-sm text-muted-foreground/70 select-none">
            Conversation Compacted
          </span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )
    }

    const level = message.infoLevel || 'info'
    const config = {
      info: { icon: Info, className: 'text-muted-foreground' },
      warning: { icon: AlertTriangle, className: 'text-info' },
      error: { icon: CircleAlert, className: 'text-destructive' },
      success: { icon: CheckCircle2, className: 'text-success' },
    }[level]
    const Icon = config.icon

    return (
      <div className={cn('flex items-center gap-2 px-3 py-1 text-[13px] select-none', config.className)}>
        <div className="w-3 h-3 flex items-center justify-center shrink-0">
          <Icon className="w-3 h-3" />
        </div>
        <span>{message.content}</span>
      </div>
    )
  }

  // === WARNING 消息:Info 主题气泡 ===
  if (message.role === 'warning') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-info/10 rounded-[8px] pl-5 pr-4 pt-2 pb-2.5 break-words select-none">
          <div className="text-xs text-info/50 mb-0.5 font-semibold">
            Warning
          </div>
          <p className="text-sm text-info">{message.content}</p>
        </div>
      </div>
    )
  }

  return null
}

/**
 * MemoizedMessageBubble - 阻止非流式消息的重新渲染
 *
 * 流式输出期间,整个消息列表会在每个 delta 上更新。
 * 此包装器会跳过未变化消息的重新渲染,
 * 显著提升长对话的性能。
 */
const MemoizedMessageBubble = React.memo(MessageBubble, (prev, next) => {
  // 流式消息始终重新渲染(内容正在变化)
  if (prev.message.isStreaming || next.message.isStreaming) {
    return false
  }
  // 若关键 props 未变化则跳过重新渲染
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.role === next.message.role &&
    prev.sessionId === next.sessionId &&
    prev.compactMode === next.compactMode
  )
})
