/**
 * ChatDisplay — React 组件
 * 
 * 所属目录：app-shell
 */
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

/** 懒加载 CSS.highlights，避免模块初始化 / HMR 时拿到过期引用 */
function getCSSHighlights(): Map<string, Highlight> | undefined {
  try {
    return (CSS as any).highlights as Map<string, Highlight> | undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// 浮层状态类型
// ============================================================================

/** 多文件 diff 浮层状态（Edit/Write 类 activity） */
interface MultiDiffOverlayState {
  type: 'multi-diff'
  changes: FileChange[]
  consolidated: boolean
  focusedChangeId?: string
}

/** Markdown 浮层状态（弹出详情、回合详情、通用 activity） */
interface MarkdownOverlayState {
  type: 'markdown'
  content: string
  title: string
  /** 为 true 时直接显示原始 Markdown 源码，而不是渲染预览 */
  forceCodeView?: boolean
}

/** 所有浮层状态的联合类型；null 表示没有浮层 */
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
  // 连接选择（第一条消息后锁定）
  /** LLM 连接变化回调；只在会话为空时有效 */
  onConnectionChange?: (connectionSlug: string) => void
  /** 输入框 ref，供外部控制焦点 */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** 为 true 时禁用输入（例如 agent 需要激活） */
  disabled?: boolean
  /** 本会话待处理的权限请求 */
  pendingPermission?: PermissionRequest
  /** 响应权限请求的回调 */
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../../shared/types').PermissionResponseOptions
  ) => void
  /** 本会话待处理的凭据请求 */
  pendingCredential?: CredentialRequest
  /** 响应凭据请求的回调 */
  onRespondToCredential?: (sessionId: string, requestId: string, response: CredentialResponse) => void
  // 思考层级（会话级设置）
  /** 当前思考层级：'off' / 'think' / 'max' */
  thinkingLevel?: ThinkingLevel
  /** 思考层级变化回调 */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // 高级选项
  /** 当前权限模式 */
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Shift+Tab 循环时可用的权限模式 */
  enabledModes?: PermissionMode[]
  // 输入值保持（由父组件受控）
  /** 当前输入值；在模式切换和会话切换间保持 */
  inputValue?: string
  /** 输入值变化回调 */
  onInputChange?: (value: string) => void
  /** 本会话的附件草稿（由 ChatPage 从磁盘恢复） */
  attachmentsValue?: FileAttachment[]
  /** 附件草稿变化回调（添加、删除、发送后清空） */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  // Source 选择
  /** 可用 sources（仅启用的） */
  sources?: LoadedSource[]
  /** source 选择变化回调 */
  onSourcesChange?: (slugs: string[]) => void
  // Skill 选择（用于 @mention 自动补全）
  /** 可用于 @mention 自动补全的 skills */
  skills?: LoadedSkill[]
  // Label 选择（用于 #labels）
  /** 可用标签配置（树形），用于标签菜单和徽标展示 */
  labels?: import('@craft-agent/shared/labels').LabelConfig[]
  /** 标签变化回调 */
  onLabelsChange?: (labels: string[]) => void
  // 状态选择（用于 # 菜单和 ActiveOptionBadges）
  /** 可用工作流状态 */
  sessionStatuses?: import('@/config/session-status-config').SessionStatus[]
  /** 会话状态变化回调 */
  onSessionStatusChange?: (stateId: string) => void
  /** 工作区 ID，用于加载 skill 图标 */
  workspaceId?: string
  // 工作目录（按会话）
  /** 本会话当前工作目录 */
  workingDirectory?: string
  /** 工作目录变化回调 */
  onWorkingDirectoryChange?: (path: string) => void
  /** 会话文件夹路径（用于“重置到会话根目录”选项） */
  sessionFolderPath?: string
  // 懒加载
  /** 为 true 时表示消息仍在加载，消息区域显示 spinner */
  messagesLoading?: boolean
  /** 消息加载失败提示，替代无限 spinner */
  messagesLoadError?: string | null
  /** 是否正在重试加载 */
  messagesRetrying?: boolean
  /** 重试加载会话记录 */
  onRetryMessagesLoad?: () => void
  // 新手引导
  /** 禁用发送（用于引导步骤） */
  disableSend?: boolean
  // 搜索高亮（来自会话列表搜索）
  /** 用于高亮匹配项的搜索关键字，由会话列表传入 */
  searchQuery?: string
  /** 搜索模式是否激活（防止焦点被抢回聊天输入框） */
  isSearchModeActive?: boolean
  /** 匹配信息变化回调，用于即时更新 UI */
  onMatchInfoChange?: (info: { count: number; index: number; isHighlighting: boolean; sessionId: string | null }) => void
  // 紧凑模式（用于 EditPopover 嵌入、auto-compact / WebUI 移动端）
  /** 启用紧凑模式：隐藏非必要 UI，适合嵌入弹窗 */
  compactMode?: boolean
  /**
   * compactMode 为 true 时，在权限模式 pill 旁启用紧凑（抽屉式）模型选择器。
   * 默认 false，保证 EditPopover 保持现有行为；ChatPage 在 auto-compact / 移动端时启用。
   */
  enableCompactModelPicker?: boolean
  /** 输入框自定义占位文案（紧凑模式下编辑上下文用） */
  placeholder?: string | string[]
  /** 紧凑模式下空状态显示的标签（如“权限设置”） */
  emptyStateLabel?: string
  /** 为 true 时表示会话锁定的连接已被移除：禁用发送并显示不可用状态 */
  connectionUnavailable?: boolean
}

import {
  formatFollowUpSection,
  normalizeFollowUpsMarkdown,
  truncateForChipTooltip,
  type PendingFollowUpAnnotation,
} from './ChatDisplay.follow-ups'

/**
 */
export interface ChatDisplayHandle {
  goToNextMatch: () => void
  goToPrevMatch: () => void
  matchCount: number
  currentMatchIndex: number
  isHighlighting: boolean
}

/**
 * 处理中的状态文案 key 列表，会随机循环展示。
 * 灵感来自 Claude Code 的轻松风格状态提示。
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
 * 格式化已用时间：不到一分钟显示 "45s"，一分钟以上显示 "1:02"
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

interface ProcessingIndicatorProps {
  /** 开始时间戳（跨重挂载保持） */
  startTime?: number
  /** 用固定状态文案覆盖循环文案（例如 "Compacting..."） */
  statusMessage?: string
}

/**
 * ProcessingIndicator：显示循环状态文案和已用时间。
 * 布局与 TurnCard 头部保持一致，确保视觉连贯。
 */
function ProcessingIndicator({ startTime, statusMessage }: ProcessingIndicatorProps) {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = React.useState(0)
  const [messageIndex, setMessageIndex] = React.useState(() =>
    Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
  )

  // 根据传入的 startTime 每秒更新已用时间
  React.useEffect(() => {
    const start = startTime || Date.now()
    // 立即设置初始值
    setElapsed(Math.floor((Date.now() - start) / 1000))

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startTime])

  // 每 10 秒切换一次文案（仅在没传固定 statusMessage 时）
  React.useEffect(() => {
    if (statusMessage) return  // 有固定状态时不循环
    const interval = setInterval(() => {
      setMessageIndex(prev => {
        // 随机挑一个不同的文案
        let next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        while (next === prev && PROCESSING_MESSAGE_KEYS.length > 1) {
          next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        }
        return next
      })
    }, 10000)
    return () => clearInterval(interval)
  }, [statusMessage])

  // 传了固定状态就用固定状态，否则使用循环文案
  const displayMessage = statusMessage || t(PROCESSING_MESSAGE_KEYS[messageIndex])

  return (
    <div className="flex items-center gap-2 px-3 py-1 -mb-1 text-[13px] text-muted-foreground">
      {/* Spinner 放在和 TurnCard chevron 相同的位置 */}
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      {/* 文案切换时只做交叉淡入淡出动画 */}
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
 * 挂载后立即滚动到目标元素；在浏览器绘制前执行。
 * 使用 useLayoutEffect 确保内容可见前完成滚动。
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
 * ChatDisplay：选中会话的主聊天界面。
 *
 * 结构：
 * - 会话头部：头像 + 工作区名
 * - 消息区：可滚动的消息气泡列表
 * - 输入区：文本框 + 发送按钮
 *
 * 未选中会话时显示空状态。
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
  // 思维层面

  thinkingLevel = 'medium',
  onThinkingLevelChange,
  // 
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes,
  // 输入值保存

  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  // 
  sources,
  onSourcesChange,
  // 
  skills,
  // 
  labels,
  onLabelsChange,
  // 
  sessionStatuses,
  onSessionStatusChange,
  workspaceId,
  // 
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  // 延迟加载

  messagesLoading = false,
  messagesLoadError,
  messagesRetrying = false,
  onRetryMessagesLoad,
  // 
  disableSend = false,
  // 
  searchQuery: externalSearchQuery,
  isSearchModeActive = false,
  onMatchInfoChange,
  // 紧凑模式（用于 EditPopover 嵌入和自动紧凑/WebUI 移动）

  compactMode = false,
  enableCompactModelPicker = false,
  placeholder,
  emptyStateLabel,
  // 连接不可用

  connectionUnavailable = false,
}, ref) {
  const { t } = useTranslation()

  // 面板焦点状态（用于多面板自动滚动行为）
  const appShellContext = useAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // 输入框只在显式禁用时才禁用（例如 agent 需要激活）。
  // 流式输出期间用户仍可输入，提交会停止流并发送。
  const isInputDisabled = disabled
  const messagesEndRef = React.useRef<HTMLDivElement>(null)
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const prevSessionIdRef = React.useRef<string | null>(null)
  // 反向分页：初始只展示最后 N 个回合，向上滚动时加载更多
  const TURNS_PER_PAGE = 20
  const [visibleTurnCount, setVisibleTurnCount] = React.useState(TURNS_PER_PAGE)
  // 吸底开关：为 true 时内容变化自动滚动到底部；由用户滚动行为切换
  const isStickToBottomRef = React.useRef(true)
  // 把 isFocusedPanel 同步到 ref，保证 ResizeObserver 回调里读到最新值
  const isFocusedPanelRef = React.useRef(isFocusedPanel)
  isFocusedPanelRef.current = isFocusedPanel
  // 会话切换后短暂跳过平滑滚动（已经用瞬时滚动处理过）
  const skipSmoothScrollUntilRef = React.useRef(0)
  // 记录消息提交边界，当新的用户消息真正落入状态时再自动滚动
  // （附件延迟乐观插入时尤其重要）。
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

  // 会话分叉导航
  const { navigate } = useNavigation()

  // 从 useTheme 获取是否为暗色主题，用于浮层主题
  // 这会处理像 Haze 这样强制暗色的风景主题
  const { isDark } = useTheme()

  // 注册为焦点区域：当区域获得焦点时，聚焦输入框
  // 用 isFocusedPanelRef 做守卫，多面板布局下只有聚焦面板响应
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

  // TurnCard 展开状态——跨会话切换持久化到 localStorage
  const {
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  } = useTurnCardExpansion(session?.id)


  // ============================================================================
  // 搜索高亮（来自会话列表搜索）
  // ============================================================================
  // 当前匹配索引（内部状态，通过 ref 暴露给外部导航）
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const turnRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  // 运行时注入 ::highlight() 样式，避免 LightningCSS 构建警告
  //（当前构建优化器还不把 ::highlight 当成合法伪元素）
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
  // 控制何时滚动到匹配项：仅在带搜索切换会话，或用户点击导航按钮时
  const shouldScrollToMatchRef = React.useRef(false)
  const prevSessionIdForScrollRef = React.useRef<string | null>(null)

  // 使用外部传入的搜索关键字
  const searchQuery = externalSearchQuery || ''
  // 至少 2 个字符才激活聊天内搜索（和会话列表的 isSearchMode 对齐）
  const isSearchActive = searchQuery.trim().length >= 2

  // 当焦点区域通过键盘（Tab、Cmd+3、方向右）获得焦点时，聚焦输入框。
  // 需要 isFocused 为 true——遵守焦点区域架构。
  // 不会仅因会话切换就自动聚焦（那会抢走 SessionList 的焦点）。
  // 使用 isSearchModeActive（props）而不是 isSearchActive（基于查询），
  // 防止搜索框打开但查询为空时焦点被抢走。
  // 多面板布局下，只有聚焦面板才会自动聚焦自己的输入框。
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

  // 会话或搜索关键字变化时重置匹配状态
  useEffect(() => {
    const isSessionSwitch = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
    prevSessionIdForScrollRef.current = session?.id ?? null

    // 如果切换会话时搜索仍激活，触发滚动到第一个匹配
    if (isSessionSwitch && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }

    setCurrentMatchIndex(0)
  }, [session?.id, searchQuery, isSearchActive])

  // 统计子串出现次数的辅助函数
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

  // 找出每个单独匹配出现的位置（不只是哪些 turn）
  // 返回的数组里每项带唯一 matchId
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

      // 文本扫描和 DOM ref 使用同一个 getTurnKey，保证 ID 一致
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

      // 统计该 turn 文本中的出现次数
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

  // 搜索激活时自动展开分页，确保所有含匹配的 turn 都可见
  // 这样匹配数量稳定，并且一开始就能高亮所有命中项
  useEffect(() => {
    if (!isSearchActive || matchingOccurrences.length === 0) return

    // 找到最早出现匹配的 turn 索引（用 reduce 避免大数组 RangeError）
    const earliestMatchTurnIndex = matchingOccurrences.reduce(
      (min, m) => m.turnIndex < min ? m.turnIndex : min,
      matchingOccurrences[0]!.turnIndex
    )
    const totalTurns = groupMessagesByTurn(session?.messages || [], { isSessionProcessing: session?.isProcessing }).length

    // 计算需要显示多少个 turn 才能包含所有匹配。
    // 
    // 所以 requiredVisibleCount = totalTurns - earliestMatchTurnIndex + 上下文缓冲。
    const requiredVisibleCount = totalTurns - earliestMatchTurnIndex + 5 // +5 作为上下文缓冲

    if (requiredVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(requiredVisibleCount)
    }
  }, [isSearchActive, matchingOccurrences, session?.messages, session?.isProcessing, visibleTurnCount])

  // 提取有匹配的 turn ID（去重），供高亮使用
  const matchingTurnIds = useMemo(() => {
    const uniqueTurnIds = new Set(matchingOccurrences.map(m => m.turnId))
    return Array.from(uniqueTurnIds)
  }, [matchingOccurrences])

  // CSS Custom Highlight API 直接用逻辑匹配驱动导航，不需要再校验 DOM。
  const validMatches = matchingOccurrences

  // 只有唯一匹配时才自动滚动；
  // 多个匹配时让用户用上下 chevron 导航，避免突兀滚动。
  useEffect(() => {
    if (validMatches.length === 1 && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }
  }, [validMatches.length, isSearchActive])

  // 滚动到当前匹配 turn
  // 仅在 shouldScrollToMatchRef 为 true 时执行（单匹配自动滚动或导航按钮点击）
  useEffect(() => {
    if (!shouldScrollToMatchRef.current) return

    if (validMatches.length > 0 && currentMatchIndex < validMatches.length) {
      const matchData = validMatches[currentMatchIndex]
      const { turnId, turnIndex } = matchData
      const totalTurns = totalTurnCountRef.current

      // 如果匹配在当前可见范围之外，先扩展分页
      const currentStartIndex = Math.max(0, totalTurns - visibleTurnCount)
      if (turnIndex < currentStartIndex) {
        const newVisibleCount = totalTurns - turnIndex + 5
        setVisibleTurnCount(newVisibleCount)
        return
      }

      // 把 turn 滚入视野
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
  // CSS Custom Highlight API：非破坏式文本高亮
  // 在不修改 DOM 树的情况下，为匹配文本创建浏览器原生高亮范围。
  // 对 React 重渲染和流式输出都安全。
  // 使用跨节点匹配：把多个文本节点拼接起来查找，能命中跨节点边界的内容
  //（例如被 Shiki 拆分的 token）。
  // ---------------------------------------------------------------------------

  const MAX_HIGHLIGHT_RANGES = 5000
  // 缓存已计算的范围，让 active-match 效果可以在不重走 DOM 的情况下重新着色
  const highlightRangesRef = React.useRef<Range[]>([])

  // Effect 1：搜索/会话/分页变化时遍历 DOM，收集高亮范围
  useEffect(() => {
    const cssHighlights = getCSSHighlights()
    highlightRangesRef.current = []

    // 清除上一次高亮
    try {
      cssHighlights?.delete('search-passive')
      cssHighlights?.delete('search-active')
    } catch { /* API 不可用——静默忽略 */ }

    if (!searchQuery.trim() || !isSearchActive || !cssHighlights) return

    const query = searchQuery.toLowerCase()
    const matchingTurnIdSet = new Set(matchingTurnIds)
    if (matchingTurnIdSet.size === 0) return

    const rafId = requestAnimationFrame(() => {
      const allRanges: Range[] = []

      turnRefs.current.forEach((container, turnKey) => {
        if (allRanges.length >= MAX_HIGHLIGHT_RANGES) return
        if (!matchingTurnIdSet.has(turnKey)) return

        // assistant turn 只在其回复内容根节点内搜索
        const searchRoot = container.querySelector('[data-search-root="response"]') || container

        // 收集所有符合条件的文本节点（不过滤查询关键字——跨节点匹配需要完整文本）
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

        // 为跨节点匹配构建拼接字符串和节点偏移映射
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

          // 创建跨越匹配区域的 Range（可能跨多个节点）
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
            // 遍历期间节点被移除可能导致 Range 创建失败
          }

          searchPos = matchEnd
        }
      })

      // 把范围存起来，供 active-match effect 使用
      highlightRangesRef.current = allRanges

      if (allRanges.length === 0 && matchingTurnIdSet.size > 0) {
        console.warn('[search-highlight] 0 ranges from', matchingTurnIdSet.size, 'matching turns — possible turn ID mismatch')
      }

      if (allRanges.length === 0) return

      try {
        // 初始全部设为 passive；active-match effect 会重新着色当前项
        cssHighlights.set('search-passive', new Highlight(...allRanges))
      } catch {
        // Highlight API 调用失败——优雅降级
      }
    })

    return () => cancelAnimationFrame(rafId)
  }, [searchQuery, isSearchActive, matchingTurnIds, session?.id, visibleTurnCount])

  // Effect 2：导航索引变化时更新 active/passive 高亮分割
  // 很轻量——只是在两个 Highlight 实例之间重新分配已有的 Range 对象
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

  // 导航到下一个匹配（不循环，到末尾停止）
  const goToNextMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // 不循环
      if (prev >= validMatches.length - 1) return prev
      shouldScrollToMatchRef.current = true
      return prev + 1
    })
  }, [validMatches])

  // 导航到上一个匹配（不循环，到开头停止）
  const goToPrevMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // 不循环
      if (prev <= 0) return prev
      shouldScrollToMatchRef.current = true
      return prev - 1
    })
  }, [validMatches])

  // CSS Highlight API 高亮是即时的，没有 settling 阶段
  const isHighlighting = false

  // 通过 imperative handle 暴露导航能力（供会话列表导航控制使用）
  React.useImperativeHandle(ref, () => ({
    goToNextMatch,
    goToPrevMatch,
    matchCount: validMatches.length,
    currentMatchIndex,
    isHighlighting,
  }), [goToNextMatch, goToPrevMatch, validMatches.length, currentMatchIndex])

  // 当匹配信息（数量、索引、高亮状态）变化时通知父组件
  useEffect(() => {
    onMatchInfoChange?.({
      count: validMatches.length,
      index: currentMatchIndex,
      isHighlighting,
      sessionId: session?.id ?? null,
    })
  }, [validMatches.length, currentMatchIndex, isHighlighting, session?.id, onMatchInfoChange])

  // ============================================================================
  // 浮层状态管理
  // ============================================================================

  // 浮层状态：控制当前显示哪个浮层（如果有）
  const [overlayState, setOverlayState] = useState<OverlayState>(null)

  // Diff 查看器设置：挂载时从用户偏好读取，变化时持久化
  // 这些设置存在 ~/.craft-agent/preferences.json 里（不是 localStorage）
  const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})

  // 挂载时加载 diff 查看器设置
  useEffect(() => {
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        if (prefs.diffViewer) {
          setDiffViewerSettings(prefs.diffViewer)
        }
      } catch {
        // 解析错误时忽略，使用默认值
      }
    })
  }, [])

  // diff 查看器设置变化时写回偏好文件
  const handleDiffViewerSettingsChange = useCallback((settings: DiffViewerSettings) => {
    setDiffViewerSettings(settings)
    // 读取当前偏好，合并新设置后写回
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        prefs.diffViewer = settings
        prefs.updatedAt = Date.now()
        window.electronAPI.writePreferences(JSON.stringify(prefs, null, 2))
      } catch {
        // 如果偏好文件损坏，只写入 diffViewer 重建
        window.electronAPI.writePreferences(JSON.stringify({ diffViewer: settings, updatedAt: Date.now() }, null, 2))
      }
    })
  }, [])

  // 关闭浮层
  const handleCloseOverlay = useCallback(() => {
    setOverlayState(null)
  }, [])

  // 从 activity 浮层中提取卡片（Input/Output 等，方便后续扩展）
  const overlayCards = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return []
    return extractOverlayCards(overlayState.activity)
  }, [overlayState])

  // 旧版仅 output 的 activity 浮层解析数据
  const activityOutputOverlayData = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return null
    return extractOverlayData(overlayState.activity)
  }, [overlayState])

  // 堆叠输入/输出卡片仅对 Bash 和 MCP 工具启用
  const useStackedActivityOverlay = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return false
    return isStackedActivityTool(overlayState.activity)
  }, [overlayState])

  // 弹出消息到浮层（只读 markdown）
  const handlePopOut = useCallback((message: Message) => {
    if (!session) return
    setOverlayState({
      type: 'markdown',
      content: message.content,
      title: 'Message Preview',
    })
  }, [session])

  // 用于滚动处理中读取总 turn 数量
  const totalTurnCountRef = React.useRef(0)

  // 最新消息元数据（用于提交时刻的自动滚动）
  const messageCount = session?.messages.length ?? 0
  const lastMessage = messageCount > 0 ? session?.messages[messageCount - 1] : undefined
  const lastMessageId = lastMessage?.id
  const lastMessageRole = lastMessage?.role

  // 收集待处理的批注跟进项
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

  // 监听滚动位置来切换吸底行为：
  // - 用户向上滚动 → 取消吸底（停止自动滚动）
  // - 用户滚回底部 → 恢复吸底（继续自动滚动）
  // 同时处理靠近顶部时加载更多回合
  const handleScroll = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    const { scrollTop, scrollHeight, clientHeight } = viewport
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    // 用 20px 阈值判断“是否在底部”
    isStickToBottomRef.current = distanceFromBottom < 20

    // 靠近顶部（100px 内）时加载更多回合
    if (scrollTop < 100) {
      setVisibleTurnCount(prev => {
        // 检查是否还有未显示的回合
        const currentStartIndex = Math.max(0, totalTurnCountRef.current - prev)
        if (currentStartIndex <= 0) return prev // 已经全部显示

        // 记住添加新项之前的滚动高度
        const prevScrollHeight = viewport.scrollHeight

        // 渲染后调整滚动位置，避免跳动
        requestAnimationFrame(() => {
          const newScrollHeight = viewport.scrollHeight
          viewport.scrollTop = newScrollHeight - prevScrollHeight + scrollTop
        })

        return prev + TURNS_PER_PAGE
      })
    }
  }, [])

  // 绑定滚动事件监听
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 用 ResizeObserver 在流式内容输出时自动滚动。
  // 初始滚动由 ScrollOnMount（useLayoutEffect，绘制前）处理。
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const isSessionSwitch = prevSessionIdRef.current !== session?.id
    prevSessionIdRef.current = session?.id ?? null

    // 会话切换时重置 UI 状态（滚动本身交给 ScrollOnMount）
    if (isSessionSwitch) {
      isStickToBottomRef.current = true
      setVisibleTurnCount(TURNS_PER_PAGE)
    }

    // 流式滚动防抖：等布局稳定后再滚动
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const resizeObserver = new ResizeObserver(() => {
      // 非聚焦面板：用户没在查看，总是瞬时滚到底
      if (!isFocusedPanelRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
        return
      }

      // 聚焦面板：尊重吸底偏好
      if (!isStickToBottomRef.current) return

      // 清除待处理滚动，等布局稳定
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        // 如果刚做过瞬时滚动（会话切换/懒加载），跳过平滑滚动
        if (Date.now() < skipSmoothScrollUntilRef.current) return
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 200)
    })

    // 观察滚动视口的内容容器（viewport 的第一个子元素）
    const content = viewport.firstElementChild
    if (content) {
      resizeObserver.observe(content)
    }

    return () => {
      resizeObserver.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [session?.id])

  // 新用户消息真正落入状态后的提交时刻自动滚动。
  // 补充提交时的滚动，覆盖附件延迟乐观插入的情况（如缩略图生成/缩放）。
  React.useEffect(() => {
    const currentSessionId = session?.id ?? null

    // 会话切换时重置基准；滚动逻辑交给 ScrollOnMount / 会话切换逻辑。
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

    // 提前更新基准，即使后面直接 return，也能保持 ref 一致
    prevLastMessageIdRef.current = lastMessageId ?? null
    prevMessageCountRef.current = messageCount

    if (!messageActuallyChanged || !countIncreased) return
    if (lastMessageRole !== 'user') return

    // 发送消息时总是重新吸底
    isStickToBottomRef.current = true

    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: isFocusedPanelRef.current ? 'smooth' : 'instant',
      })
    })
  }, [session?.id, messageCount, lastMessageId, lastMessageRole])

  // 处理 InputContainer 的消息提交
  // 后端会处理当前正在处理时的中断和排队
  const handleSubmit = (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => {
    const hasBaseMessage = message.trim().length > 0
    const followUpSection = formatFollowUpSection(pendingFollowUpAnnotations, {
      includeTopSeparator: hasBaseMessage,
    })
    const messageWithFollowUps = followUpSection.length > 0
      ? (hasBaseMessage ? `${message}\n\n${followUpSection}` : followUpSection)
      : message
    const normalizedMessage = normalizeFollowUpsMarkdown(messageWithFollowUps)

    // 当用户发送消息时强制粘到底部

* 通过forwardRef公开命令句柄，用于在比赛之间导航
 
自动化列表 - 如果自动化过滤器处于活动状态，则按类型过滤  
是否启用本地MCP服务器（影响stdio源状态）
所有标签都通过点击进行导航——父标签和叶子标签都一样
当位于第一个菜单项并按向上键时，重新聚焦搜索输入
面板焦点导航（CMD+SHIFT+[ / ]）
“标签”标题：显示至少具有一个标签的所有活动会话
源自焦点小组的路线——所有小组都是同行的
颜色继承的包装。克隆图标以添加裸道具（删除 EntityIcon 容器）。
仅关注目标会话的聊天输入（多面板安全）。
将键盘突出显示的项目滚动到视图中
创建一个全新的专用浏览器窗口并将其聚焦。
第一次按显示警告覆盖，第二次按中断
重新生成标题时闪烁动画。  
选择自动化时保留当前的自动化过滤器
统一索引的状态计数偏移量
会话将发出更新会话状态的“labels_changed”事件
3. 来源、技能、背景
各个待办事项状态视图的处理程序

* MessageBubble - 根据其角色呈现单个消息
*
* 消息角色和样式：
* - 用户：右对齐、蓝色（背景前景）、白色文本
* - 助理：左对齐、灰色（背景静音）、使用可点击链接呈现的 Markdown
* - 错误：左对齐、红色边框/背景、警告图标 + 错误消息
 * - 状态：带有脉冲点的居中药丸徽章（例如，t("chat.processing.thinking")）
*
* 注意：工具消息由 TurnCard 呈现，而不是 MessageBubble
 
--- 会话部分 ---
ChatDisplay 突出显示的搜索状态
使用“add-label”上下文打开 EditPopover，存储右键单击的标签
特定标签：包括标有此标签或任何后代的会话
不再使用 SessionStatusIcons - 图标来自动态 sessionStatuses
聚焦模式 - 隐藏侧边栏，仅显示聊天内容  
将 StatusConfig 转换为带有解析图标的 SessionStatus
将触发器元素上的 data-edit-active 属性与 EditPopover 打开状态同步。
删除源 - 由于代理系统被删除而简化
实际上聚焦 DOM 元素
这修复了 CMD+R 丢失过滤器的问题 - 以前仅在工作区切换上运行
退出（注意：也由 macOS 上的本机菜单处理）
当配置观察器触发时清除乐观状态（statusConfigs 更改）
传播基本配置，覆盖上下文以包括右键单击的标签
这可以在显示弹出窗口时使侧边栏项目在视觉上突出显示，
1. 会话部分：所有带有状态项、已标记、存档为子项的会话（可展开）
非活动组：自切换项目，然后是子项
每个过滤器条目存储用于三态过滤的模式（“包含”或“排除”）。
检查是否有任何子级具有活动过滤器（以在父级上显示指示器）
    isStickToBottomRef.current = true
    onSendMessage(normalizedMessage, attachments, skillSlugs)

    // 在批注跟进项上持久化“已发送”标记，让 TurnCard 区分已发送和待发送。
    // 如果用户后续编辑跟进，TurnCard 会清除这些标记，重新变为待发送。
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

    // 发送后立即滚动到底部；用 requestAnimationFrame 确保 DOM 已更新
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

    // Save 完成后模拟按下了输入框的发送按钮
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('craft:submit-input', {
        detail: { sessionId: session.id },
      }))
    }, 0)
  }, [session, isInputDisabled, disableSend, connectionUnavailable])

  // 处理来自 InputContainer 的停止请求
  // silent=true 表示重定向（发送新消息），silent=false 表示用户点击 Stop 按钮
  const handleStop = (silent = false) => {
    if (!session?.isProcessing) return

    // 显式 Stop（不是重定向/发新消息）：把进行中的提示词放回输入框，方便用户修改重发。
    // 追加到现有草稿后。排除 isQueued 消息——那些由后端 `restore_input` 效果单独恢复，
    // 否则这里会重复追加。
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

  // 输入框高度动画期间逐帧补偿滚动
  // 只在用户处于“吸底”状态时补偿，否则保留用户手动滚动位置
  const handleAnimatedHeightChange = React.useCallback((delta: number) => {
    if (!isStickToBottomRef.current) return
    const viewport = scrollViewportRef.current
    if (!viewport) return
    // 调整 scrollTop，保持相对内容的位置
    viewport.scrollTop += delta
  }, [])

  // 处理结构化输入响应（权限和凭据）
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

  // 根据待处理请求构建结构化输入状态（权限优先）
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

  // 缓存 turn 分组结果，避免每次渲染/按键都 O(n) 遍历
  const allTurns = React.useMemo(() => {
    if (!session) return []
    return groupMessagesByTurn(session.messages, { isSessionProcessing: session.isProcessing })
  }, [session?.messages, session?.isProcessing])

  // 同步总 turn 数给滚动处理使用
  totalTurnCountRef.current = allTurns.length

  // 反向分页：初始只渲染最后 N 个 turn，加快首屏渲染
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

  // 判断本次渲染是否应跳过自动滚到底（会话切换且搜索激活时优先滚动到匹配）
  // 渲染时 prevSessionIdForScrollRef 还保存旧会话 ID，因此能检测切换
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
          {/* === 消息区：可滚动的消息气泡列表 === */}
          <div className="relative flex-1 min-h-0">
            {/* 遮罩：在透明/图片背景上让顶部和底部内容渐隐 */}
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
                {/* 会话级 AnimatePresence：切换会话时避免布局跳动 */}
                <AnimatePresence mode={compactMode ? "sync" : "wait"} initial={false}>
                  <motion.div
                    key={compactMode ? 'compact-session' : session?.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                  >
                    {/* 加载/内容 AnimatePresence：sync 模式防止旧 loading 退出动画遮住已就绪内容 */}
                    <AnimatePresence mode="sync" initial={false}>
                    {messagesLoading ? (
                      /* 加载状态：懒加载消息时显示 spinner */
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
                    /* 基于 turn 的消息展示（已 memo，避免每次渲染重新分组） */
                    /* AnimatePresence 处理从加载状态过渡时的淡入 */
                    <motion.div
                      key={compactMode ? 'loaded-compact' : `loaded-${session?.id}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                    >
                  {/* 绘制前滚到底：通过 useLayoutEffect 触发 */}
                  {/* 会话切换且搜索激活时跳过，改为滚动到第一个匹配 */}
                  <ScrollOnMount
                    targetRef={messagesEndRef}
                    skip={skipScrollToBottom}
                    onScroll={() => {
                      skipSmoothScrollUntilRef.current = Date.now() + 500
                    }}
                  />
                  {/* 紧凑模式空状态：在弹窗中居中显示引导文案 */}
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
                  {/* “上方还有更多消息”提示 */}
                  {hasMoreAbove && (
                    <div className="text-center text-muted-foreground/60 text-xs py-3 select-none">
                      ↑ {t('chat.scrollUpForEarlier', { count: startIndex })}
                    </div>
                  )}
                  {turns.map((turn, index) => {
                    // 计算 turn key，并判断是否为搜索匹配
                    const turnKey = getTurnKey(turn)
                    const isCurrentMatch = isSearchActive && matchingTurnIds[currentMatchIndex] === turnKey
                    const isAnyMatch = isSearchActive && matchingTurnIds.includes(turnKey)

                    // 用户 turn：用 MemoizedMessageBubble 渲染
                    // 额外间距让 AI 回复之间有视觉分隔
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

                    // 系统 turn（error/status/info/warning）：用 MemoizedMessageBubble 渲染
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

                    // 认证请求 turn：直接内联渲染认证 UI
                    // mt-2 与 ResponseCard 间距一致，保证视觉统一
                    if (turn.type === 'auth-request') {
                      // 只有后面没有用户消息时才可交互
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

                    // 判断是否是最后一条回复（用于“接受计划”按钮是否显示）
                    const isLastResponse = index === turns.length - 1 || !turns.slice(index + 1).some(t => t.type === 'user')

                    // Assistant turn：用 TurnCard 渲染（带缓冲流式）
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
                                // 通过继承父会话设置，将分支保持在同一后端/提供程序上。

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
                          // 在代码查看器中打开原始 Markdown 源码
                          setOverlayState({
                            type: 'markdown',
                            content: text,
                            title: 'Response Preview',
                            forceCodeView: true,
                          })
                        }}
                        onOpenDetails={() => {
                          // 在 Markdown 浮层中打开 turn 详情
                          const markdown = formatTurnAsMarkdown(turn)
                          setOverlayState({
                            type: 'markdown',
                            content: markdown,
                            title: 'Turn Details',
                          })
                        }}
                        onOpenActivityDetails={(activity) => {
                          // Write 工具写入 .md/.txt → 使用文档浮层（渲染后的 Markdown），
                          // 而不是 diff 浮层，因为这类文件更适合作为格式化文档查看
                          const isDocumentWrite = activity.toolName === 'Write' && (() => {
                            const actInput = activity.toolInput as Record<string, unknown> | undefined
                            const fp = (actInput?.file_path as string) || ''
                            const ext = fp.split('.').pop()?.toLowerCase()
                            return ext === 'md' || ext === 'txt'
                          })()

                          // Edit/Write 工具 → 多文件 diff 浮层（非分组模式，聚焦本次改动）
                          // 例外：写入 .md/.txt 时走文档浮层
                          if ((activity.toolName === 'Edit' || activity.toolName === 'Write') && !isDocumentWrite) {
                            const changes = collectFileChangesFromActivities(turn.activities)
                            if (changes.length > 0) {
                              setOverlayState({
                                type: 'multi-diff',
                                changes,
                                consolidated: false, // 非分组模式：显示单个改动
                                focusedChangeId: getFirstFileChangeIdForActivity(activity.id, changes),
                              })
                            }
                          } else {
                            // 其他工具 → 通用 activity 卡片浮层（Input/Output）
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
                              consolidated: true, // 分组模式：按文件分组
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
                {/* Processing Indicator - always visible while processing */}
                {session.isProcessing && (() => {
                  // 
                  const lastUserMsg = [...session.messages].reverse().find(m => m.role === 'user')
                  return (
                    <ProcessingIndicator
                      startTime={lastUserMsg?.timestamp}
                      statusMessage={session.currentStatus?.message}
                    />
                  )
                })()}
                {/* Scroll Anchor: For auto-scroll to bottom */}
                <div ref={messagesEndRef} />
              </div>
              </ScrollArea>
            </div>
          </div>

          {/* === INPUT CONTAINER: FreeForm or Structured Input === */}
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
      {/* Preview Overlays - Rendered outside the main chat flow            */}
      {/* ================================================================== */}

      {/* Activity details overlay */}
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

      {/* Legacy output-only activity overlay for non-bash/non-mcp tools */}
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

      {/* Multi-diff preview overlay (Edit/Write tools) */}
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

      {/* Markdown preview overlay (pop-out, turn details) */}
      {/* forceCodeView: show raw markdown source in code viewer (used by "View as Markdown" button) */}
      {/* otherwise: render formatted markdown (used by turn details, etc.) */}
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
 */
interface MessageBubbleProps {
  message: Message
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  sessionId?: string
  /**
   */
  renderMode?: RenderMode
  /**
   */
  onPopOut?: (message: Message) => void
  /**
   * 紧凑模式 - 减少弹出窗口嵌入的填充  
   */
  compactMode?: boolean
  /**
   */
  onRetry?: () => void
}

/**
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
      {/* Subtle bg (3% opacity) + tinted shadow for softer error appearance */}
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

        {/* Action buttons */}
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

        {/* Collapsible Details Toggle */}
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

  // 
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

  // === 辅助消息：左对齐灰色气泡，带有 markdown 渲染 ===

  if (message.role === 'assistant') {
    return (
      <div className="flex justify-start group">
        <div className="relative max-w-[90%] bg-background shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0 select-text">
          {/* Pop-out button - visible on hover */}
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
          {/* Use StreamingMarkdown for block-level memoization during streaming */}
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

  // === 错误消息：带有警告图标和可折叠详细信息的红色边框气泡 ===

  if (message.role === 'error') {
    return <ErrorMessage message={message} onOpenUrl={onOpenUrl} sessionId={sessionId} onRetry={onRetry} />
  }

  // === 状态消息：匹配ProcessingIndicator 布局以实现视觉一致性===

  if (message.role === 'status') {
    return (
      <div className="flex items-center gap-2 px-3 py-1 -mb-1 text-[13px] text-muted-foreground">
        {/* Spinner in same location as TurnCard chevron */}
        <div className="w-3 h-3 flex items-center justify-center shrink-0">
          <Spinner className="text-[10px]" />
        </div>
        <span>{message.content}</span>
      </div>
    )
  }

  // === 信息消息：基于级别的图标和颜色 ===

  if (message.role === 'info') {
    // 压缩完成消息 - 渲染为带有居中标签的水平线

    // 重新加载后仍然存在，以显示上下文被压缩的位置

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

  // 
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
 */
const MemoizedMessageBubble = React.memo(MessageBubble, (prev, next) => {
  // 
  if (prev.message.isStreaming || next.message.isStreaming) {
    return false
  }
  // 如果关键道具不变则跳过重新渲染

  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.role === next.message.role &&
    prev.sessionId === next.sessionId &&
    prev.compactMode === next.compactMode
  )
})
