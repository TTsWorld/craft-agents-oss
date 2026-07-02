/**
 * FreeFormInput — React 组件
 * 
 * 所属目录：input
 */
import * as React from 'react'
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from 'motion/react'
import {
  Paperclip,
  ArrowUp,
  Square,
  Check,
  DatabaseZap,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Image as ImageIcon,
} from 'lucide-react'
import { Icon_Home, Spinner } from '@craft-agent/ui'

import * as storage from '@/lib/local-storage'
import { Button } from '@/components/ui/button'
import {
  InlineSlashCommand,
  useInlineSlashCommand,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu'
import {
  InlineMentionMenu,
  useInlineMention,
  type MentionItem,
  type MentionItemType,
} from '@/components/ui/mention-menu'
import {
  InlineLabelMenu,
  useInlineLabelMenu,
} from '@/components/ui/label-menu'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { parseMentions } from '@/lib/mentions'
import { RichTextInput, type RichTextInputHandle } from '@/components/ui/rich-text-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuPortal,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { coerceInputText } from '@/lib/input-text'
import { isMac } from '@/lib/platform'
import { applySmartTypography } from '@/lib/smart-typography'
import { AttachmentPreview } from '../AttachmentPreview'
import { ImageSupportWarningBanner } from './ImageSupportWarningBanner'
import { ANTHROPIC_MODELS, getModelShortName, getModelDisplayName, getModelContextWindow, type ModelDefinition } from '@config/models'
import {
  resolveEffectiveConnectionSlug,
  isCompatProvider,
  modelSupportsImages,
} from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { SourceSelectorPopover } from '@/components/ui/SourceSelectorPopover'
import { CompactSourceSelector } from '@/components/ui/CompactSourceSelector'
import { CompactWorkingDirectorySelector } from '@/components/ui/CompactWorkingDirectorySelector'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { derivePickerMode } from './picker-mode'
import type { FileAttachment, LoadedSource, LoadedSkill } from '../../../../shared/types'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import { type ThinkingLevel, THINKING_LEVELS, getThinkingLevelNameKey } from '@craft-agent/shared/agent/thinking-levels'
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { ToolbarStatusSlot } from './ToolbarStatusSlot'
import { buildPlanApprovalMessage } from '../plan-approval-message'
import { shouldHandleScopedInputEvent } from './input-event-guards'
import { clearPendingFocusForSession, consumePendingFocusForSession } from './focus-input-events'
import {
  getRecentWorkingDirs,
  addRecentWorkingDir,
} from './working-directory-history'
import { WorkingDirectorySelector, formatPathForDisplay } from './WorkingDirectorySelector'
import { CompactPermissionModeSelector } from './CompactPermissionModeSelector'
import { CompactModelSelector } from './CompactModelSelector'
import {
  formatTokenCount,
  groupConnectionsByProvider,
  stripPiPrefixForDisplay,
} from './model-picker-helpers'
import { useModelVisionToggle } from './useModelVisionToggle'

function formatFollowUpChipText(text: string, fallback: string, maxLength = 50): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}


/** 键盘快捷键的平台相关修饰键（macOS 用 ⌘，其他用 Ctrl） */
const cmdKey = isMac ? '⌘' : 'Ctrl'

/** 默认轮播占位文案在 FreeFormInput 内通过 useMemo + t() 生成 */

/** Fisher-Yates 洗牌算法：返回随机排序的新数组 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/** FollowUpInputItem：类型定义 */
export interface FollowUpInputItem {
  id: string
  messageId: string
  annotationId: string
  index?: number
  noteLabel: string
  selectedText: string
  color?: string
}

/** FreeFormInputProps：组件 props 类型定义 */
export interface FreeFormInputProps {
  /** 文本域占位文案；可传数组实现轮播 */
  placeholder?: string | string[]
  /** 是否禁用输入 */
  disabled?: boolean
  /** 当前会话是否正在处理中 */
  isProcessing?: boolean
  /** 消息提交回调（skillSlugs 来自 @mentions） */
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  /** 停止处理回调；silent=true 时跳过“响应已中断”提示 */
  onStop?: (silent?: boolean) => void
  /** 输入框的外部 ref */
  inputRef?: React.RefObject<RichTextInputHandle>
  /** 当前模型 ID */
  currentModel: string
  /** 模型变化回调（同时传入连接 slug，保证持久化正确） */
  onModelChange: (model: string, connection?: string) => void
  // 思考等级（会话级设置）
  /** 当前思考等级（'off'、'think'、'max'） */
  thinkingLevel?: ThinkingLevel
  /** 思考等级变化回调 */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // 高级选项
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Shift+Tab 循环时可用的权限模式（至少 2 个） */
  enabledModes?: PermissionMode[]
  // 受控输入值：跨模式切换和会话变更时持久化草稿
  /** 当前输入值；提供后组件变为受控组件 */
  inputValue?: string
  /** 输入值变化回调 */
  onInputChange?: (value: string) => void
  /** 本会话的持久化附件草稿（切换会话时用于初始化本地状态） */
  attachmentsValue?: FileAttachment[]
  /** 附件列表变化回调（添加、移除、发送后清空） */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  /** 为 true 时移除容器样式（阴影、背景、圆角），被 InputContainer 包裹时使用 */
  unstyled?: boolean
  /** 组件高度变化回调（用于外部动画同步） */
  onHeightChange?: (height: number) => void
  /** 聚焦状态变化回调 */
  onFocusChange?: (focused: boolean) => void
  // Source 选择
  /** 可用 sources（仅已启用） */
  sources?: LoadedSource[]
  /** 当前会话已启用的 source slugs */
  enabledSourceSlugs?: string[]
  /** source 选择变化回调 */
  onSourcesChange?: (slugs: string[]) => void
  // Skill 选择（用于 @mentions）
  /** @mention 自动补全可用的 skills */
  skills?: LoadedSkill[]
  // Label 选择（用于 #labels）
  /** #label 自动补全可用的 labels */
  labels?: LabelConfig[]
  /** 当前会话已应用的 labels */
  sessionLabels?: string[]
  /** 通过 # 菜单添加 label 时的回调 */
  onLabelAdd?: (labelId: string) => void
  /** 加载 skill 图标用的工作区 ID */
  workspaceId?: string
  /** 当前工作目录路径 */
  workingDirectory?: string
  /** 工作目录变化回调 */
  onWorkingDirectoryChange?: (path: string) => void
  /** 会话文件夹路径（用于“重置为会话根目录”选项） */
  sessionFolderPath?: string
  /** 会话 ID，用于限定 approve-plan 等事件的作用域 */
  sessionId?: string
  /** 当前会话状态（用于 # 菜单状态选择） */
  currentSessionStatus?: string
  /** 禁用发送操作（用于教程引导） */
  disableSend?: boolean
  /** 会话是否为空（还没有消息）；影响上下文徽章的显隐 */
  isEmptySession?: boolean
  /** 上下文状态，用于显示压缩指示器和 token 用量 */
  contextStatus?: {
    /** SDK 正在压缩对话时为 true */
    isCompacting?: boolean
    /** 本会话至今已使用的输入 tokens */
    inputTokens?: number
    /** 模型上下文窗口大小（tokens） */
    contextWindow?: number
  }
  /** 显示在输入框上方的跟进注解上下文芯片 */
  followUpItems?: FollowUpInputItem[]
  /** 用户点击跟进芯片主体时的回调 */
  onFollowUpClick?: (item: FollowUpInputItem, anchor?: { x: number; y: number }) => void
  /** 用户点击跟进芯片序号徽标时的回调 */
  onFollowUpIndexClick?: (item: FollowUpInputItem) => void
  /**
   * 紧凑底部布局。EditPopover（弹出框嵌入）和 ChatPage 的自动紧凑/WebUI 移动端都会用到。
   * 弹出框场景会隐藏模型选择器；自动紧凑场景通过 `enableCompactModelPicker` 启用紧凑选择器。


   */
  compactMode?: boolean
  /**
   * 当 `compactMode` 为 true 时，在权限模式 pill 旁渲染紧凑（抽屉式）模型选择器。
   * 默认 false，因为 EditPopover 不需要模型选择器，保持其原有行为。


   */
  enableCompactModelPicker?: boolean
  // 连接选择（层级：连接 → 模型选择器）
  /** 当前 LLM 连接 slug（第一条消息后锁定） */
  currentConnection?: string
  /** 连接变化回调（仅在会话为空时有效） */
  onConnectionChange?: (connectionSlug: string) => void
  /** 为 true 表示会话锁定的连接已被删除 */
  connectionUnavailable?: boolean
  /**
   * 当 agent 正在 compact 模式下处理且用户尚未展开输入栏时为 true。
   * 该状态由 `InputContainer` 持有，通过 `onRequestExpand` 切换回来。

   */
  isCollapsedInCompact?: boolean
  /** 用户点击或悬停折叠输入条时触发。 */
  onRequestExpand?: () => void
}

/**
 * FreeFormInput - 自包含的文本域输入组件，支持附件和控制按钮
 *
 * 功能：
 * - 自动增高文本域
 * - 通过按钮或拖拽添加文件附件
 * - 斜杠命令菜单
 * - 模型选择器
 * - 活动选项徽章
 */
export function FreeFormInput({
  placeholder,
  disabled = false,
  isProcessing = false,
  onSubmit,
  onStop,
  inputRef: externalInputRef,
  currentModel,
  onModelChange,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes = ['safe', 'ask', 'allow-all'],
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  sources = [],
  enabledSourceSlugs = [],
  onSourcesChange,
  skills = [],
  labels = [],
  sessionLabels = [],
  onLabelAdd,
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  sessionId,
  currentSessionStatus,
  disableSend = false,
  isEmptySession = false,
  contextStatus,
  followUpItems = [],
  onFollowUpClick,
  onFollowUpIndexClick,
  compactMode = false,
  enableCompactModelPicker = false,
  currentConnection,
  onConnectionChange,
  connectionUnavailable = false,
  isCollapsedInCompact = false,
  onRequestExpand,
}: FreeFormInputProps) {
  const { t } = useTranslation()

  // 默认轮播占位文案，用于引导/空状态（已做国际化处理）
  const defaultPlaceholders = React.useMemo(() => [
    t("chatInput.placeholder.workOn"),
    t("chatInput.placeholder.shiftTab"),
    t("chatInput.placeholder.mention"),
    t("chatInput.placeholder.labels"),
    t("chatInput.placeholder.newLine"),
    t("chatInput.placeholder.sidebar", { key: cmdKey }),
    t("chatInput.placeholder.focusMode", { key: cmdKey }),
  ], [t])

  const effectivePlaceholderProp = placeholder ?? defaultPlaceholders

  // 从上下文读取连接默认模型、连接列表和工作区信息。
  // 使用可选上下文，避免 playground（无 provider）崩溃。
  const appShellCtx = useOptionalAppShellContext()
  const llmConnections = appShellCtx?.llmConnections ?? []
  const workspaceDefaultConnection = appShellCtx?.workspaceDefaultLlmConnection

  // 根据实际生效的连接推导每个会话的 connectionDefaultModel。
  // 仅在 compat provider（固定模型的自定义端点）下非空。
  // 标准 provider（anthropic、pi）返回 null，使用普通模型选择器。
  const connectionDefaultModel = React.useMemo(() => {
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const conn = llmConnections.find(c => c.slug === effectiveSlug)
    if (!conn) return null
    if (!isCompatProvider(conn.providerType)) return null
    // 当连接配置了多个模型时允许切换模型
    if (conn.models && conn.models.length > 1) return null
    return conn.defaultModel ?? null
  }, [currentConnection, workspaceDefaultConnection, llmConnections])

  // 决定渲染四种选择器 UI 中的哪一种。`switcher` 分支优先级高于 `locked-single`，
  // 这样默认使用单模型 pi_compat 连接的新会话也能打开连接切换器（修复 #727）。

  const pickerMode = derivePickerMode({
    connectionUnavailable,
    connectionDefaultModel,
    isEmptySession,
    connectionCount: llmConnections.length,
  })

  // 从实际生效的连接计算可用模型列表。
  // 所有连接的模型列表都由 backfillAllConnectionModels() 填充。
  const availableModels = React.useMemo(() => {
    // 当前连接已被移除，不要回退到其他连接的模型列表
    if (connectionUnavailable) return []

    // 使用规范回退链确定实际生效的连接
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const connection = llmConnections.find(c => c.slug === effectiveSlug)

    if (!connection) {
      return ANTHROPIC_MODELS // Safety net — shouldn't happen
    }

    return connection.models || ANTHROPIC_MODELS
  }, [llmConnections, currentConnection, workspaceDefaultConnection, connectionUnavailable])

  const availableThinkingLevels = THINKING_LEVELS

  // 当前模型明确不支持思考时禁用思考选择器
  const thinkingDisabled = React.useMemo(() => {
    const model = availableModels.find(m => typeof m !== 'string' && m.id === currentModel)
    return typeof model !== 'string' && model?.supportsThinking === false
  }, [availableModels, currentModel])

  // 获取当前模型的显示名称（完整名，不是短名）
  const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = connectionDefaultModel ?? currentModel
    const model = availableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay
    )
    if (!model) {
      // 兜底：用辅助函数把未知模型 ID 格式化成友好的显示名
      return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    }
    if (typeof model === 'string') return stripPiPrefixForDisplay(model)
    // 防御性处理：自定义端点用户配置或图片开关升级产生的条目可能缺少 `name`，
    // 回退到 id，避免触发按钮空白。

    return model.name ?? stripPiPrefixForDisplay(model.id)
  }, [availableModels, currentModel, connectionDefaultModel])

  // 按提供商类型对连接分组，用于层级下拉菜单。
  // 每个提供商（Anthropic、Pi）下可以有多个连接（API Key、OAuth 等）。
  const connectionsByProvider = React.useMemo(
    () => groupConnectionsByProvider(llmConnections),
    [llmConnections],
  )

  // 查找当前连接详情用于展示
  const currentConnectionDetails = React.useMemo(() => {
    if (!currentConnection) return null
    return llmConnections.find(c => c.slug === currentConnection) ?? null
  }, [llmConnections, currentConnection])

  // 实际生效连接：规范回退链（会话 → 工作区默认 → 全局默认 → 首个连接）
  const effectiveConnection = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)

  // 实际生效连接详情（含回退），用于获取模型列表
  // 与 currentConnectionDetails 不同：未显式设置连接时后者为 null，
  // 这里会解析到真正在用的连接（包括工作区默认连接）。
  const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])


  // 从上下文读取 sessionStatuses 和 onSessionStatusChange，用于 # 菜单的状态选择器
  const sessionStatuses = appShellCtx?.sessionStatuses ?? []
  const onSessionStatusChange = appShellCtx?.onSessionStatusChange
  // 解析工作区 rootPath，用于“添加新标签”的深链跳转
  const workspaceRootPath = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return null
    return appShellCtx.workspaces.find(w => w.id === workspaceId)?.rootPath ?? null
  }, [appShellCtx, workspaceId])

  // SDK  skill 识别用的工作区 slug（由服务端计算）
  // SDK 要求格式为 "workspaceSlug:skillSlug"，而不是 UUID
  const workspaceSlug = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return workspaceId
    return appShellCtx.workspaces.find(w => w.id === workspaceId)?.slug ?? workspaceId
  }, [appShellCtx, workspaceId])

  // 从上下文读取面板聚焦状态（用于多面板非聚焦态样式）
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // 每次挂载时打乱占位文案顺序，让不同会话有新鲜感。
  // compact 模式下隐藏依赖桌面键盘的提示，这些提示在窄屏/移动端会喧宾夺主或产生误导。

  const placeholderOptions = React.useMemo(() => {
    if (!Array.isArray(placeholder)) return placeholder
    if (!compactMode) return placeholder
    return placeholder.filter((entry) => {
      const lower = entry.toLowerCase()
      return !lower.includes('shift + tab')
        && !lower.includes('shift + return')
        && !lower.includes('toggle the sidebar')
        && !lower.includes('focus mode')
        && !lower.includes('⌘')
        && !lower.includes('ctrl')
    })
  }, [placeholder, compactMode])

  // 多面板布局中当前面板未聚焦时完全隐藏占位文案
  const shuffledPlaceholder = React.useMemo(
    () => Array.isArray(effectivePlaceholderProp) ? shuffleArray(effectivePlaceholderProp) : effectivePlaceholderProp,
    [] // eslint-disable-line react-hooks/exhaustive-deps -- intentionally shuffle only on mount
  )
  const effectivePlaceholder = isFocusedPanel ? shuffledPlaceholder : ''

  // 性能优化：输入时始终使用内部状态，避免父组件频繁重渲染。
  // 挂载/变更时从父组件同步（用于恢复草稿）。
  // 失焦/提交时同步回父组件（带防抖持久化）。
  const [input, setInput] = React.useState(() => coerceInputText(inputValue))
  const [attachments, setAttachments] = React.useState<FileAttachment[]>(attachmentsValue ?? [])

  // 用 ref 跟踪当前附件，供事件回调使用（避免闭包过时）。
  const attachmentsRef = React.useRef<FileAttachment[]>([])
  React.useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // 当 `attachmentsValue` 变化时从父组件播种（例如切换会话）。
  // `skipPersistRef` 告诉下方的持久化 effect：下一次 `attachments` 变化来自 prop 播种，
  // 不是用户操作；否则我们会把播种回写给父组件，导致 A 会话的附件被错写到 B 会话。

  const attachmentsRefsKey = React.useMemo(() => {
    if (!attachmentsValue) return ''
    return attachmentsValue.map(a => a.path).join('|')
  }, [attachmentsValue])
  const prevAttachmentsRefsKey = React.useRef(attachmentsRefsKey)
  const skipPersistRef = React.useRef(true) // treat initial mount as a prop-seed
  React.useEffect(() => {
    if (attachmentsValue === undefined) return
    if (attachmentsRefsKey === prevAttachmentsRefsKey.current) return
    prevAttachmentsRefsKey.current = attachmentsRefsKey
    skipPersistRef.current = true
    setAttachments(attachmentsValue)
  }, [attachmentsValue, attachmentsRefsKey])

  // 把用户主动发起的附件变化持久化回父组件。父组件保存的是引用（path + name），
  // 并防抖落盘，因此每次变化都立即触发。

  const onAttachmentsChangeRef = React.useRef(onAttachmentsChange)
  onAttachmentsChangeRef.current = onAttachmentsChange
  React.useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    onAttachmentsChangeRef.current?.(attachments)
  }, [attachments])

  // Source 选择的乐观状态：在 IPC 往返完成前就更新 UI。
  const [optimisticSourceSlugs, setOptimisticSourceSlugs] = React.useState(enabledSourceSlugs)

  // 服务端状态变化时从 prop 同步（在 IPC 完成或外部更新后 reconciliation）。
  // 用内容比较而非引用比较，避免空数组触发无限循环。
  const prevEnabledSourceSlugsRef = React.useRef(enabledSourceSlugs)
  React.useEffect(() => {
    const prev = prevEnabledSourceSlugsRef.current
    const changed = enabledSourceSlugs.length !== prev.length ||
      enabledSourceSlugs.some((slug, i) => slug !== prev[i])

    if (changed) {
      setOptimisticSourceSlugs(enabledSourceSlugs)
      prevEnabledSourceSlugsRef.current = enabledSourceSlugs
    }
  }, [enabledSourceSlugs])

  // 当 inputValue 外部变化时从父组件同步（例如切换会话）。
  const prevInputValueRef = React.useRef(coerceInputText(inputValue))
  React.useEffect(() => {
    if (inputValue === undefined) return
    const nextInputValue = coerceInputText(inputValue)
    if (nextInputValue !== prevInputValueRef.current) {
      setInput(nextInputValue)
      prevInputValueRef.current = nextInputValue
    }
  }, [inputValue])

  // 防抖同步到父组件（保存草稿而不阻塞输入）。
  const syncTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)
  const syncToParent = React.useCallback((value: string) => {
    if (!onInputChange) return
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(() => {
      onInputChange(value)
      prevInputValueRef.current = value
    }, 300) // Debounce 300ms
  }, [onInputChange])

  // 卸载时立即同步，跨模式切换保留输入内容。
  // 同时清理待处理的防抖同步。
  const inputRef = React.useRef(input)
  inputRef.current = input // Keep ref in sync with state

  React.useEffect(() => {
    return () => {
      // 取消待处理的防抖同步
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
      // 卸载时立即把当前值同步给父组件
      // 切换到结构化输入（例如权限请求）时保留输入内容
      if (onInputChange && inputRef.current !== prevInputValueRef.current) {
        onInputChange(inputRef.current)
      }
    }
  }, [onInputChange])

  const [isDraggingOver, setIsDraggingOver] = React.useState(false)
  const [loadingCount, setLoadingCount] = React.useState(0)
  const [sourceDropdownOpen, setSourceDropdownOpen] = React.useState(false)
  const [isFocused, setIsFocused] = React.useState(false)
  const [inputMaxHeight, setInputMaxHeight] = React.useState(540)
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

  // 输入设置（从配置加载）
  const [autoCapitalisation, setAutoCapitalisation] = React.useState(true)
  const [sendMessageKey, setSendMessageKey] = React.useState<'enter' | 'cmd-enter'>('enter')
  const [spellCheck, setSpellCheck] = React.useState(false)

  // 挂载时加载输入设置
  React.useEffect(() => {
    const loadInputSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, sendKey, spellCheckEnabled] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSendMessageKey(),
          window.electronAPI.getSpellCheck(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSendMessageKey(sendKey ?? 'enter')
        setSpellCheck(spellCheckEnabled)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      }
    }
    loadInputSettings()
  }, [])

  // 双击 Esc 中断：第一次 Esc 显示警告覆盖层，第二次 Esc 真正中断。
  const { showEscapeOverlay } = useEscapeInterrupt()

  // 计算最大高度：取窗口高度的 66% 与 540px 中的较小值
  React.useEffect(() => {
    const updateMaxHeight = () => {
      const maxFromWindow = Math.floor(window.innerHeight * 0.66)
      setInputMaxHeight(Math.min(maxFromWindow, 540))
    }
    updateMaxHeight()
    window.addEventListener('resize', updateMaxHeight)
    return () => window.removeEventListener('resize', updateMaxHeight)
  }, [])

  const dragCounterRef = React.useRef(0)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const sourceButtonRef = React.useRef<HTMLButtonElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // 合并外部与内部的 RichTextInput ref
  const internalInputRef = React.useRef<RichTextInputHandle>(null)
  const richInputRef = externalInputRef || internalInputRef

  // 记录最后光标位置，用于重新聚焦时恢复（例如权限模式弹出框关闭后）。
  const lastCaretPositionRef = React.useRef<number | null>(null)

  // 监听 craft:insert-text 事件：通用的向输入框插入文本机制。
  // 其他组件可用此事件预填充输入框。
  React.useEffect(() => {
    const handleInsertText = (e: CustomEvent<{ text: string; sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const text = coerceInputText(e.detail?.text)
      setInput(text)
      syncToParent(text)
      // 插入后聚焦输入框
      setTimeout(() => {
        richInputRef.current?.focus()
        // 光标移到末尾
        richInputRef.current?.setSelectionRange(text.length, text.length)
      }, 0)
    }

    window.addEventListener('craft:insert-text', handleInsertText as EventListener)
    return () => window.removeEventListener('craft:insert-text', handleInsertText as EventListener)
  }, [sessionId, isFocusedPanel, syncToParent, richInputRef])

  const clearInputDraft = React.useCallback(() => {
    setInput('')
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    prevInputValueRef.current = ''
  }, [onInputChange])

  const handleToggleModelVision = useModelVisionToggle()

  const consumeInputDraftSnapshot = React.useCallback((): string => {
    const snapshot = input.trim()
    clearInputDraft()
    return snapshot
  }, [input, clearInputDraft])

  type PlanApprovalEventDetail = {
    sessionId?: string
    planPath?: string
    includeDraftInput?: boolean
    source?: string
  }

  // 监听 craft:approve-plan 事件（ResponseCard 的“接受 Plan”按钮使用）。
  // 一次性退出安全模式并提交批准消息。
  // 只处理属于当前会话的事件（sessionId 必须匹配）。
  React.useEffect(() => {
    const handleApprovePlan = (e: CustomEvent<PlanApprovalEventDetail>) => {
      // 仅当事件属于当前会话时才处理
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInput = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''
      const text = buildPlanApprovalMessage({
        planPath: e.detail?.planPath,
        draftInput,
      })

      // 如果当前是 Explore（safe）模式，则切换到 allow-all（Auto）模式，允许无提示执行。
      // 仅在 safe 模式下自动切换；若用户处于 ask 模式，则尊重其选择。
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all')
      }

      onSubmit(text, undefined)
    }

    window.addEventListener('craft:approve-plan', handleApprovePlan as EventListener)
    return () => window.removeEventListener('craft:approve-plan', handleApprovePlan as EventListener)
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot])

  // 监听 craft:approve-plan-with-compact 事件（“接受并压缩”选项）。
  // 先压缩对话，再执行 plan。
  // 将待执行状态持久化，以在 CMD+R 刷新后恢复。
  React.useEffect(() => {
    const handleApprovePlanWithCompact = async (e: CustomEvent<PlanApprovalEventDetail>) => {
      // 仅当事件属于当前会话时才处理
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const planPath = e.detail?.planPath
      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInputSnapshot = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''

      // 如果当前是 Explore（safe）模式，则切换到 allow-all（Auto）模式
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all')
      }

      // 在发送 /compact 之前先持久化待执行的 plan 状态。
      // 这样即使压缩过程中 CMD+R 刷新，也能在恢复后重试。
      if (sessionId) {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setPendingPlanExecution',
          planPath: planPath ?? '',
          draftInputSnapshot,
        })
      }

      // 发送 /compact 触发压缩
      onSubmit('/compact', undefined)

      // 设置一次性压缩完成监听器。
      // 处理正常流程（压缩期间没有刷新）。
      const handleCompactionComplete = async (compactEvent: CustomEvent<{ sessionId?: string }>) => {
        // 仅当属于当前会话时才处理
        if (compactEvent.detail?.sessionId !== sessionId) {
          return
        }

        // 移除监听器（一次性使用）
        window.removeEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)

        const executionMessage = buildPlanApprovalMessage({
          planPath,
          draftInput: draftInputSnapshot,
        })
        onSubmit(executionMessage, undefined)

        // 已发送执行消息，清除待处理状态
        if (sessionId) {
          await window.electronAPI.sessionCommand(sessionId, {
            type: 'clearPendingPlanExecution',
          })
        }
      }

      window.addEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    }

    window.addEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
    return () => window.removeEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot])

  // 刷新恢复：挂载时检查是否有待执行的 plan。
  // 如果页面在压缩完成后刷新（awaitingCompaction = false），
  // 需要补发因刷新而中断的执行消息。
  // 同时监听 compaction-complete，以处理压缩过程中 CMD+R 的情况。
  React.useEffect(() => {
    if (!sessionId) return

    let hasExecuted = false

    const isExpectedReconnectError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('Connection closed')
        || message.includes('Client disconnected')
        || message.includes('transport')
        || message.includes('socket')
    }

    const executePendingPlan = async () => {
      if (hasExecuted) return

      try {
        const pending = await window.electronAPI.getPendingPlanExecution(sessionId)
        if (!pending || pending.awaitingCompaction || pending.executionDispatched) return

        // 发送前标记为已派发，防止刷新恢复时重复提交
        // 避免因 onSubmit 成功但重连清理失败导致的同 plan 重复提交。
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'markPendingPlanExecutionDispatched',
        })

        // 压缩已完成，但执行消息未发送（页面刷新了）。
        // 现在补发并清除待处理状态。
        hasExecuted = true
        const executionMessage = buildPlanApprovalMessage({
          planPath: pending.planPath,
          draftInput: pending.draftInputSnapshot,
        })
        onSubmit(executionMessage, undefined)

        await window.electronAPI.sessionCommand(sessionId, {
          type: 'clearPendingPlanExecution',
        })
      } catch (error) {
        if (!isExpectedReconnectError(error)) {
          console.error('[FreeFormInput] Failed to resume pending plan execution:', error)
        }
      }
    }

    // 挂载后立即检查（处理压缩已完成的情况）
    executePendingPlan()

    // 同时监听 compaction-complete，处理压缩期间 CMD+R 的场景。
    // 刷新后压缩完成时，该监听器会触发执行。
    const handleCompactionComplete = async (e: CustomEvent<{ sessionId: string }>) => {
      if (e.detail?.sessionId !== sessionId) return
      // 短暂延迟，确保 markCompactionComplete 已被调用
      await new Promise(resolve => setTimeout(resolve, 100))
      executePendingPlan()
    }

    window.addEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    return () => {
      window.removeEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    }
  }, [sessionId, onSubmit])

  // 监听 craft:focus-input 事件（弹出框/下拉菜单关闭后恢复焦点）。
  React.useEffect(() => {
    const handleFocusInput = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail
      const targetSessionId = detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      if (targetSessionId) {
        clearPendingFocusForSession(targetSessionId)
      }

      richInputRef.current?.focus()
      // 如果保存了光标位置则恢复，并清空（一次性）
      if (lastCaretPositionRef.current !== null) {
        richInputRef.current?.setSelectionRange(
          lastCaretPositionRef.current,
          lastCaretPositionRef.current
        )
        lastCaretPositionRef.current = null
      }
    }

    window.addEventListener('craft:focus-input', handleFocusInput)
    return () => window.removeEventListener('craft:focus-input', handleFocusInput)
  }, [sessionId, isFocusedPanel, richInputRef])

  // 处理会话切换/挂载竞态中排队的聚焦请求。
  React.useEffect(() => {
    if (!consumePendingFocusForSession(sessionId)) return

    setTimeout(() => {
      richInputRef.current?.focus()
    }, 0)
  }, [sessionId, richInputRef])

  // 获取粘贴文件前缀的下一个可用序号（例如 pasted-image-1、pasted-image-2）
  const getNextPastedNumber = (
    prefix: 'image' | 'text' | 'file',
    existingAttachments: FileAttachment[]
  ): number => {
    const pattern = new RegExp(`^pasted-${prefix}-(\\d+)\\.`)
    let maxNum = 0
    for (const att of existingAttachments) {
      const match = att.name.match(pattern)
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
    return maxNum + 1
  }

  // 监听 craft:paste-files 事件：在输入框未聚焦时处理全局粘贴。
  React.useEffect(() => {
    const handlePasteFiles = async (e: CustomEvent<{ files: File[]; sessionId?: string }>) => {
      if (disabled) return

      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const { files } = e.detail
      if (!files || files.length === 0) return

      setLoadingCount(prev => prev + files.length)

      // 使用 ref 预分配顺序名称，避免竞态条件
      let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
      const fileNames: string[] = files.map(file => {
        if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
          const ext = file.type.split('/')[1] || 'png'
          return `pasted-image-${nextImageNum++}.${ext}`
        }
        return file.name
      })

      for (let i = 0; i < files.length; i++) {
        try {
          const attachment = await readFileAsAttachment(files[i], fileNames[i])
          if (attachment) {
            setAttachments(prev => [...prev, attachment])
          }
        } catch (error) {
          console.error('[FreeFormInput] Failed to process pasted file:', error)
        }
        setLoadingCount(prev => prev - 1)
      }

      // 添加附件后聚焦输入框
      richInputRef.current?.focus()
    }

    window.addEventListener('craft:paste-files', handlePasteFiles as unknown as EventListener)
    return () => window.removeEventListener('craft:paste-files', handlePasteFiles as unknown as EventListener)
  }, [disabled, sessionId, isFocusedPanel, richInputRef])

  // 构建斜杠命令菜单中的激活命令列表
  const activeCommands = React.useMemo(() => {
    const active: SlashCommandId[] = []
    // 加入当前激活的权限模式
    if (permissionMode === 'safe') active.push('safe')
    else if (permissionMode === 'ask') active.push('ask')
    else if (permissionMode === 'allow-all') active.push('allow-all')
    return active
  }, [permissionMode])

  // 处理斜杠命令选择（模式/功能命令）
  const handleSlashCommand = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe') onPermissionModeChange?.('safe')
    else if (commandId === 'ask') onPermissionModeChange?.('ask')
    else if (commandId === 'allow-all') onPermissionModeChange?.('allow-all')
    else if (commandId === 'compact' && !isProcessing) onSubmit('/compact', undefined)
  }, [onPermissionModeChange, isProcessing, onSubmit])

  // 处理斜杠命令菜单中的文件夹选择
  const handleSlashFolderSelect = React.useCallback((path: string) => {
    if (onWorkingDirectoryChange) {
      setRecentFolders(addRecentWorkingDir(path, workspaceId))
      onWorkingDirectoryChange(path)
    }
  }, [onWorkingDirectoryChange, workspaceId])

  // 为斜杠菜单和 mention 菜单获取最近文件夹和 home 目录
  const [recentFolders, setRecentFolders] = React.useState<string[]>([])
  const [homeDir, setHomeDir] = React.useState<string>('')

  React.useEffect(() => {
    setRecentFolders(getRecentWorkingDirs(workspaceId))
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir)
    })
  }, [workspaceId])

  // 内联斜杠命令 hook（模式、功能、文件夹）
  const inlineSlash = useInlineSlashCommand({
    inputRef: richInputRef,
    onSelectCommand: handleSlashCommand,
    onSelectFolder: handleSlashFolderSelect,
    activeCommands,
    recentFolders,
    homeDir,
  })

  // 处理 mention 选择（sources、skills、files）
  const handleMentionSelect = React.useCallback((item: MentionItem) => {
    // Source：立即启用该 source
    if (item.type === 'source' && item.source && onSourcesChange) {
      const slug = item.source.config.slug
      if (!optimisticSourceSlugs.includes(slug)) {
        const newSlugs = [...optimisticSourceSlugs, slug]
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }

    // 文本中的 @ 文件 mention 已足以给 agent 提供上下文。
    // Skill 也只需要插入文本，无需额外处理。
  }, [optimisticSourceSlugs, onSourcesChange])

  // 内联 mention hook（skills、sources、files）
  const inlineMention = useInlineMention({
    inputRef: richInputRef,
    skills,
    sources,
    basePath: workingDirectory,
    onSelect: handleMentionSelect,
    // 使用 workspace slug（而非 UUID）供 SDK 识别 skill
    workspaceId: workspaceSlug,
  })

  // 内联 label 菜单 hook（#labels）
  const handleLabelSelect = React.useCallback((labelId: string) => {
    onLabelAdd?.(labelId)
  }, [onLabelAdd])

  const inlineLabel = useInlineLabelMenu({
    inputRef: richInputRef,
    labels,
    sessionLabels,
    onSelect: handleLabelSelect,
    sessionStatuses,
    activeStateId: currentSessionStatus,
  })

  // “添加新标签”处理：清理 # 触发文本并打开受控的 EditPopover，
  // 让用户在 agent 创建标签前先描述它。
  const [addLabelPopoverOpen, setAddLabelPopoverOpen] = React.useState(false)
  const [addLabelPrefill, setAddLabelPrefill] = React.useState('')
  const handleAddLabel = React.useCallback((prefill: string) => {
    if (!workspaceRootPath) return

    // 从输入中移除 # 触发文本
    const cleaned = inlineLabel.handleSelect('')
    setInput(cleaned)
    syncToParent(cleaned)
    inlineLabel.close()

    // 保存预填文本（例如从 "#Test" 得到 "Test"）用于预填充弹出框
    // 格式为“Add new label {prefill}”，用户可直接回车或修改
    setAddLabelPrefill(prefill ? t('labels.addNewLabel', { prefill }) : '')

    // 打开创建标签的 EditPopover
    setAddLabelPopoverOpen(true)
  }, [workspaceRootPath, inlineLabel, syncToParent, t])

  // 缓存 add-label 配置，避免每次渲染都重建 EditPopover
  const addLabelEditConfig = React.useMemo(() => {
    if (!workspaceRootPath) return null
    return getEditConfig('add-label', workspaceRootPath)
  }, [workspaceRootPath])

  // 向父组件报告高度变化（用于外部动画同步）
  React.useLayoutEffect(() => {
    if (!onHeightChange || !containerRef.current) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height)
      }
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [onHeightChange])

  // compact 模式下，输入框折叠时立即上报折叠高度，
  // 保证动画时机的平滑。
  // 用户展开（或处理结束）后，ResizeObserver 接管并上报实际渲染高度。

  React.useEffect(() => {
    if (!onHeightChange) return
    if (isCollapsedInCompact) {
      // 折叠状态：仅底部工具栏可见（约 44px）
      onHeightChange(44)
    }
  }, [isCollapsedInCompact, onHeightChange])

  // 检查是否运行在 Electron 环境（存在 electronAPI）
  const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI

  // 共享辅助函数：读取 File、添加为附件、减少 loading 计数
  const processFileAttachment = async (file: File, overrideName?: string) => {
    try {
      const attachment = await readFileAsAttachment(file, overrideName)
      if (attachment) {
        setAttachments(prev => [...prev, attachment])
      }
    } catch (error) {
      console.error('[FreeFormInput] Failed to read file:', error)
    }
    setLoadingCount(prev => prev - 1)
  }

  // 文件附件处理函数
  const handleAttachClick = () => {
    if (disabled) return
    fileInputRef.current?.click()
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    setLoadingCount(prev => prev + fileList.length)

    for (const file of fileList) {
      await processFileAttachment(file)
    }

    // 重置 input，以便再次选择同一文件时仍能触发 onChange
    e.target.value = ''
  }

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  // 拖拽处理函数
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // 使用 FileReader API 读取文件的辅助函数
  const readFileAsAttachment = async (file: File, overrideName?: string): Promise<FileAttachment | null> => {
    // 在附加时捕获绝对 OS 路径。适用于 <input type="file"> 和 OS 拖拽；
    // 剪贴板粘贴和网页拖拽返回 null（没有磁盘来源）。
    // 为 null 时，草稿层会回退到内联保存内容（Track C）。
    const realPath = hasElectronAPI ? window.electronAPI.getFilePath?.(file) ?? null : null

    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = async () => {
        const result = reader.result as ArrayBuffer
        // 分块 base64 编码：btoa + reduce 在大文件（>1MB）下会失败，
        // 因为字符串拼接是 O(n²) 且浏览器有字符串长度限制。
        const bytes = new Uint8Array(result)
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
        }
        const base64 = btoa(binary)

        let type: FileAttachment['type'] = 'unknown'
        const fileName = overrideName || file.name
        if (file.type.startsWith('image/')) type = 'image'
        else if (file.type === 'application/pdf') type = 'pdf'
        else if (file.type.includes('text') || fileName.match(/\.(txt|md|json|js|ts|tsx|py|css|html)$/i)) type = 'text'
        else if (file.type.includes('officedocument') || fileName.match(/\.(docx?|xlsx?|pptx?)$/i)) type = 'office'

        const mimeType = file.type || 'application/octet-stream'

        // 文本文件：将 ArrayBuffer 解码为 UTF-8 文本
        let text: string | undefined
        if (type === 'text') {
          text = new TextDecoder('utf-8').decode(new Uint8Array(result))
        }

        let thumbnailBase64: string | undefined
        if (hasElectronAPI) {
          try {
            const thumb = await window.electronAPI.generateThumbnail(base64, mimeType)
            if (thumb) thumbnailBase64 = thumb
          } catch {
            // 缩略图生成是可选的，失败则继续
          }
        }

        resolve({
          type,
          path: realPath ?? fileName,
          name: fileName,
          mimeType,
          base64,
          text,
          size: file.size,
          thumbnailBase64,
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(file)
    })
  }

  // 文件/图片的剪贴板粘贴处理
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (disabled) return

    const clipboardItems = e.clipboardData?.files
    if (!clipboardItems || clipboardItems.length === 0) return

    // 有待处理文件：阻止默认文本粘贴行为
    e.preventDefault()

    const files = Array.from(clipboardItems)
    setLoadingCount(prev => prev + files.length)

    // 使用 ref 预分配顺序名称，避免竞态条件
    let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
    const fileNames: string[] = files.map(file => {
      if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
        const ext = file.type.split('/')[1] || 'png'
        return `pasted-image-${nextImageNum++}.${ext}`
      }
      return file.name
    })

    for (let i = 0; i < files.length; i++) {
      await processFileAttachment(files[i], fileNames[i])
    }
  }

  // 处理长文本粘贴：转换为文件附件
  const handleLongTextPaste = React.useCallback((text: string) => {
    const nextNum = getNextPastedNumber('text', attachmentsRef.current)
    const fileName = `pasted-text-${nextNum}.txt`
    const attachment: FileAttachment = {
      type: 'text',
      path: fileName,
      name: fileName,
      mimeType: 'text/plain',
      text: text,
      size: new Blob([text]).size,
    }
    setAttachments(prev => [...prev, attachment])
    // 添加附件后聚焦输入框
    richInputRef.current?.focus()
  }, []) // No deps needed - uses ref

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingOver(false)
    if (disabled) return

    const files = Array.from(e.dataTransfer.files)
    setLoadingCount(files.length)

    for (const file of files) {
      await processFileAttachment(file)
    }
  }

  // 提交消息：后端负责排队和中断
  const submitMessage = React.useCallback(() => {
    const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
    if (!hasContent || disabled) return false

    // 教程可能禁用发送，以引导用户完成特定步骤
    if (disableSend) return false

    // 解析所有 @mentions（skills、sources、folders）
    const skillSlugs = skills.map(s => s.slug)
    const sourceSlugs = sources.map(s => s.config.slug)
    const mentions = parseMentions(input, skillSlugs, sourceSlugs)

    // 启用输入中提到的、尚未启用的 source
    if (mentions.sources.length > 0 && onSourcesChange) {
      const newSlugs = [...new Set([...optimisticSourceSlugs, ...mentions.sources])]
      if (newSlugs.length > optimisticSourceSlugs.length) {
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }

    const attachmentSnapshot = attachments

    onSubmit(
      input.trim(),
      attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined,
      mentions.skills.length > 0 ? mentions.skills : undefined
    )
    setInput('')
    setAttachments([])
    // 立即清空草稿（取消待处理的防抖同步）
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    onAttachmentsChange?.([])
    prevInputValueRef.current = ''

    // 状态更新后恢复焦点
    requestAnimationFrame(() => {
      richInputRef.current?.focus()
    })

    return true
  }, [input, attachments, followUpItems, disabled, disableSend, onInputChange, onAttachmentsChange, onSubmit, skills, sources, optimisticSourceSlugs, onSourcesChange, onWorkingDirectoryChange, homeDir])

  // 监听 craft:submit-input 事件（模拟点击发送按钮）
  React.useEffect(() => {
    const handleSubmitInput = (e: CustomEvent<{ sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return
      submitMessage()
    }

    window.addEventListener('craft:submit-input', handleSubmitInput as EventListener)
    return () => window.removeEventListener('craft:submit-input', handleSubmitInput as EventListener)
  }, [sessionId, isFocusedPanel, submitMessage])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    submitMessage()
  }

  const handleStop = (silent = false) => {
    onStop?.(silent)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合输入期间，ESC 应取消组合，而不是触发应用/菜单的 ESC 行为。
    if (e.key === 'Escape' && e.nativeEvent.isComposing) {
      return
    }

    // mention 菜单打开且有可见内容时不要提交
    if (inlineMention.isOpen) {
      // 仅当菜单确实展示了项目或正在加载时才拦截导航/选择键
      const hasVisibleContent = inlineMention.sections.some(s => s.items.length > 0) || inlineMention.isSearching
      if (hasVisibleContent && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // 这些按键由 InlineMentionMenu 组件处理
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineMention.close()
        return
      }
    }

    // 斜杠命令菜单打开时不要提交，让菜单处理 Enter 键
    if (inlineSlash.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // 这些按键由 InlineSlashCommand 组件处理
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineSlash.close()
        return
      }
    }

    // label 菜单打开时不要提交，让菜单处理导航键
    if (inlineLabel.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineLabel.close()
        return
      }
    }

    // IME 组合期间跳过提交：用户正在确认组合字符，而不是发送消息。
    // 根据用户偏好处理发送快捷键：
    // - 'enter'：Enter 发送（Shift+Enter 换行）
    // - 'cmd-enter'：⌘/Ctrl+Enter 发送（Enter 换行）
    if (sendMessageKey === 'enter') {
      // Enter 发送，Shift+Enter 换行
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // 同时允许 Cmd/Ctrl+Enter 发送（高级用户快捷键）
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
    } else {
      // cmd-enter 模式：⌘/Ctrl+Enter 发送，普通 Enter 换行
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // 允许普通 Enter 透传（换行）
    }
    if (e.key === 'Escape') {
      // 如果弹出框/覆盖层打开，跳过失焦：让覆盖层处理 ESC。
      // 避免焦点被拉回输入框时输入框消费 ESC，
      // 而弹出框仍可见（portal DOM 隔离导致事件无法到达弹出框的 DismissableLayer）。

      if (!hasOpenOverlay()) {
        richInputRef.current?.blur()
      }
    }
  }

  // 处理来自 RichTextInput 的输入变化
  const handleInputChange = React.useCallback((value: string) => {
    const nextValue = coerceInputText(value)
    // 更新状态前先获取之前的输入值
    const prevValue = inputRef.current

    setInput(nextValue)
    syncToParent(nextValue) // Debounced sync to parent for draft persistence

    // 当输入中的 mentions 被删除时同步 source 选择
    if (onSourcesChange) {
      const sourceSlugs = sources.map(s => s.config.slug)

      // 解析前后两次输入中的 mentions
      const prevMentions = parseMentions(prevValue, [], sourceSlugs)
      const currMentions = parseMentions(nextValue, [], sourceSlugs)

      // 移除之前被提到但现在不再被提到的 source
      const removedSources = prevMentions.sources.filter(slug => !currMentions.sources.includes(slug))
      if (removedSources.length > 0) {
        const newSlugs = optimisticSourceSlugs.filter(slug => !removedSources.includes(slug))
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }
  }, [syncToParent, sources, optimisticSourceSlugs, onSourcesChange])

  // 处理带光标位置的输入（用于菜单检测）
  const handleRichInput = React.useCallback((value: string, cursorPosition: number) => {
    const nextValue = coerceInputText(value)

    // 更新内联斜杠命令状态
    inlineSlash.handleInputChange(nextValue, cursorPosition)

    // 更新内联 mention 状态（@mentions：skills、sources、folders）
    inlineMention.handleInputChange(nextValue, cursorPosition)

    // 更新内联 label 状态（#labels）
    inlineLabel.handleInputChange(nextValue, cursorPosition)

    // 首字母自动大写（斜杠命令、@mentions、#labels 除外）
    // 仅在 autoCapitalisation 设置开启时生效
    let newValue = nextValue
    if (autoCapitalisation && nextValue.length > 0 && nextValue.charAt(0) !== '/' && nextValue.charAt(0) !== '@' && nextValue.charAt(0) !== '#') {
      const capitalizedFirst = nextValue.charAt(0).toUpperCase()
      if (capitalizedFirst !== nextValue.charAt(0)) {
        newValue = capitalizedFirst + nextValue.slice(1)
        // 在状态更新前设置光标位置，以便 useEffect 同步值时使用
        richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
        setInput(newValue)
        syncToParent(newValue)
        return
      }
    }

    // 应用智能排版（如 -> 转换为 →）
    const typography = applySmartTypography(nextValue, cursorPosition)
    if (typography.replaced) {
      newValue = typography.text
      // 在状态更新前设置光标位置，以便 useEffect 同步值时使用
      richInputRef.current?.setSelectionRange(typography.cursor, typography.cursor)
      setInput(newValue)
      syncToParent(newValue)
    }
  }, [inlineSlash, inlineMention, inlineLabel, syncToParent, autoCapitalisation])

  // 处理内联斜杠命令选择（移除 /command 文本）
  const handleInlineSlashCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    const newValue = inlineSlash.handleSelectCommand(commandId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // 处理内联斜杠文件夹选择（插入目录徽章）
  const handleInlineSlashFolderSelect = React.useCallback((path: string) => {
    const newValue = inlineSlash.handleSelectFolder(path)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // 处理内联 mention 选择（插入合适的 mention 文本）
  const handleInlineMentionSelect = React.useCallback((item: MentionItem) => {
    const { value: newValue, cursorPosition } = inlineMention.handleSelect(item)
    setInput(newValue)
    syncToParent(newValue)
    // 徽章渲染后聚焦输入框并恢复光标位置
    setTimeout(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    }, 0)
  }, [inlineMention, syncToParent])

  // 处理内联 label 选择（从输入中移除 #label 文本）
  const handleInlineLabelSelect = React.useCallback((labelId: string) => {
    const newValue = inlineLabel.handleSelect(labelId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent])

  // 处理 # 菜单中的状态选择（移除 #text，修改会话状态）
  const handleInlineStateSelect = React.useCallback((stateId: string) => {
    const newValue = inlineLabel.handleSelect('')
    setInput(newValue)
    syncToParent(newValue)
    if (sessionId) {
      onSessionStatusChange?.(sessionId, stateId)
    }
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent, sessionId, onSessionStatusChange])

  const followUpLayoutKey = React.useMemo(
    () => followUpItems.map(item => [
      item.id,
      item.index ?? '',
      item.noteLabel,
      item.selectedText,
      item.color ?? '',
    ].join('::')).join('|'),
    [followUpItems]
  )
  const previousFollowUpLayoutKeyRef = React.useRef<string | null>(null)
  const [animateFollowUpLayout, setAnimateFollowUpLayout] = React.useState(false)

  React.useEffect(() => {
    const previous = previousFollowUpLayoutKeyRef.current
    previousFollowUpLayoutKeyRef.current = followUpLayoutKey

    if (previous == null || previous === followUpLayoutKey) return

    setAnimateFollowUpLayout(true)
    const timer = window.setTimeout(() => {
      setAnimateFollowUpLayout(false)
    }, 220)

    return () => window.clearTimeout(timer)
  }, [followUpLayoutKey])

  const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0

  // 图片支持预检：如果已选图片会被 Pi SDK 静默剥离，则给出警告。
  // 这发生在当前自定义端点模型仅支持文本时。
  // 只对 pi_compat 生效：内置模型目录（anthropic/pi）由 SDK 管理，UI 这里无法修复。

  const hasStagedImages = attachments.some(a => a.type === 'image' || a.mimeType?.startsWith('image/'))
  const showVisionWarning =
    hasStagedImages
    && !!effectiveConnectionDetails
    && isCompatProvider(effectiveConnectionDetails.providerType)
    && !modelSupportsImages(effectiveConnectionDetails, currentModel)

  return (
    <form onSubmit={handleSubmit}>
      <div
        ref={containerRef}
        className={cn(
          'overflow-hidden transition-all',
          // 容器样式：仅当不被 InputContainer 包裹时才生效
          !unstyled && 'rounded-[16px] shadow-middle',
          !unstyled && 'bg-background',
          isDraggingOver && 'ring-2 ring-foreground ring-offset-2 ring-offset-background bg-foreground/5'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* 斜杠命令自动补全 */}
        <InlineSlashCommand
          open={inlineSlash.isOpen}
          onOpenChange={(open) => !open && inlineSlash.close()}
          sections={inlineSlash.sections}
          activeCommands={activeCommands}
          onSelectCommand={handleInlineSlashCommandSelect}
          onSelectFolder={handleInlineSlashFolderSelect}
          filter={inlineSlash.filter}
          position={inlineSlash.position}
        />

        {/* Mention 自动补全（skills、sources、files） */}
        <InlineMentionMenu
          open={inlineMention.isOpen}
          onOpenChange={(open) => !open && inlineMention.close()}
          sections={inlineMention.sections}
          onSelect={handleInlineMentionSelect}
          filter={inlineMention.filter}
          position={inlineMention.position}
          workspaceId={workspaceId}
          maxWidth={280}
          isSearching={inlineMention.isSearching}
        />

        {/* Label 与状态自动补全（#labels / #states） */}
        <InlineLabelMenu
          open={inlineLabel.isOpen}
          onOpenChange={(open) => !open && inlineLabel.close()}
          items={inlineLabel.items}
          onSelect={handleInlineLabelSelect}
          onAddLabel={handleAddLabel}
          filter={inlineLabel.filter}
          position={inlineLabel.position}
          states={inlineLabel.states}
          activeStateId={inlineLabel.activeStateId}
          onSelectState={handleInlineStateSelect}
        />

        {/* 受控的“添加新标签”EditPopover：用户在下拉中选中该选项时打开。
            the option from the # menu with no matches.
            Spread the full config so optional fields like `inlineExecution`,
            `displayLabel`, and `displayLabelKey` reach the popover. The previous
            cherry-pick dropped `inlineExecution: true`, which made the popover
            fall back to the same-window deep-link path; that worked inside
            Electron but launched the desktop app from the WebUI via `craftagents://`.
            与 AppShell 中已使用的展开模式保持一致。 */}
        {addLabelEditConfig && (
          <EditPopover
            trigger={<span className="absolute top-0 left-0 w-0 h-0 overflow-hidden" />}
            open={addLabelPopoverOpen}
            onOpenChange={setAddLabelPopoverOpen}
            {...addLabelEditConfig}
            defaultValue={addLabelPrefill}
            secondaryAction={workspaceRootPath ? {
              label: 'Edit File',
              filePath: `${workspaceRootPath}/labels/config.json`,
            } : undefined}
            side="top"
            align="start"
          />
        )}

        {/* 图片支持预检警告：仅针对 pi_compat 连接，
            where the renderer can both detect text-only models and offer to
            就地切换该模型 supportsImages 覆盖的入口。 */}
        {showVisionWarning && effectiveConnectionDetails && (
          <ImageSupportWarningBanner
            modelName={currentModelDisplayName}
            onEnable={() => handleToggleModelVision(effectiveConnectionDetails.slug, currentModel, true)}
          />
        )}

        {/* 附件预览 */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          disabled={disabled}
          loadingCount={loadingCount}
        />

        {/* 跟进上下文芯片 */}
        <AnimatePresence initial={false}>
          {followUpItems.length > 0 && (
            <motion.div
              key="follow-up-chips"
              layout={animateFollowUpLayout}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <motion.div layout={animateFollowUpLayout} className="px-3 pt-3.5 pb-0">
                <motion.div layout={animateFollowUpLayout} className="flex flex-wrap gap-1">
                  <AnimatePresence initial={false}>
                    {followUpItems.map((item, idx) => {
                      const chipIndex = item.index ?? idx + 1
                      const tooltipText = item.selectedText.trim() || t('chat.selectedText')
                      const selectedExcerpt = formatFollowUpChipText(item.selectedText, t('chat.selectedText'), 50)
                      const noteExcerpt = formatFollowUpChipText(item.noteLabel, t('chat.followUp'), 50)

                      return (
                        <motion.button
                          key={item.id}
                          type="button"
                          layout={animateFollowUpLayout}
                          initial={{ opacity: 0, y: 6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{ duration: 0.16, ease: [0.2, 0, 0.2, 1] }}
                          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[6px] bg-foreground/2 pl-1.5 pr-2 py-1 text-[13px] text-foreground/80 select-none transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            onFollowUpClick?.(item, {
                              x: rect.left + rect.width / 2,
                              y: rect.top - 8,
                            })
                          }}
                        >
                          <Tooltip delayDuration={250}>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                className="inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded-[4px] bg-background px-0.5 text-[10px] font-medium text-foreground shadow-minimal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  onFollowUpIndexClick?.(item)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    onFollowUpIndexClick?.(item)
                                  }
                                }}
                              >
                                {chipIndex}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[420px] break-words text-xs">
                              {tooltipText}
                            </TooltipContent>
                          </Tooltip>
                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap pr-0.5 text-left">
                            <span className="italic text-foreground/60">{selectedExcerpt}</span>
                            <span className="mx-1 text-foreground/40">·</span>
                            <span>{noteExcerpt}</span>
                          </span>
                        </motion.button>
                      )
                    })}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 富文本输入框（带内联 mention 徽章） */}
        {/* compact 模式下，agent 处理期间隐藏输入框，
            直到用户点击/悬停折叠条将其展开。 */}
        {!isCollapsedInCompact && (
        <RichTextInput
          ref={richInputRef}
          value={input}
          onChange={handleInputChange}
          onInput={handleRichInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onLongTextPaste={handleLongTextPaste}
          onFocus={() => { setIsFocused(true); onFocusChange?.(true) }}
          onBlur={() => {
            // 失焦前保存光标位置（以便通过 craft:focus-input 恢复）
            lastCaretPositionRef.current = richInputRef.current?.selectionStart ?? null
            setIsFocused(false)
            onFocusChange?.(false)
          }}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          skills={skills}
          sources={sources}
          workspaceId={workspaceSlug}
          className="pl-5 pr-4 pt-4 pb-3 overflow-y-auto min-h-[88px]"
          style={{ maxHeight: inputMaxHeight }}
          data-tutorial="chat-input"
          spellCheck={spellCheck}
        />
        )}

        {/* 底部工具栏：控制按钮，外层 relative 容器用于状态槽覆盖层 */}
        <div className="relative">
          {/* 状态槽覆盖层：Esc 中断提示（最高优先级）、浏览器状态等 */}
          <ToolbarStatusSlot
            showEscapeOverlay={isProcessing && showEscapeOverlay}
            sessionId={sessionId}
          />

          <div className={cn("flex items-center gap-1 px-2 py-2", !compactMode && "border-t border-border/50")}>
          {/* 附件按钮的隐藏文件 input（compact 与桌面端共用） */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          {/* compact 模式：权限模式抽屉 + attach/sources/working dir 的标准图标徽章。
              Wrapper absorbs all squeeze so the model label truncates first and the send button stays
              anchored to the right (craft-agents-oss#798). overflow-hidden is safe — Radix Drawer /
              内部的下拉通过 portal 渲染，不会被裁剪。 */}
          {compactMode && (
          <div className="flex items-center gap-1 min-w-0 shrink overflow-hidden">
          {onPermissionModeChange && (
            <CompactPermissionModeSelector
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
            />
          )}
          {enableCompactModelPicker && (
            <CompactModelSelector
              currentModel={currentModel}
              currentConnection={currentConnection}
              onModelChange={onModelChange}
              onConnectionChange={onConnectionChange}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={onThinkingLevelChange}
              isEmptySession={isEmptySession}
              connectionUnavailable={connectionUnavailable}
              contextStatus={contextStatus}
            />
          )}
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attach")
            }
            isExpanded={false}
            hasSelection={attachments.length > 0}
            showChevron={false}
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />
          {onSourcesChange && (
            <div className="relative shrink min-w-0">
              <FreeFormInputContextBadge
                buttonRef={sourceButtonRef}
                icon={
                  optimisticSourceSlugs.length === 0 ? (
                    <DatabaseZap className="h-4 w-4" />
                  ) : (
                    <div className="flex items-center -ml-0.5">
                      {(() => {
                        const enabledSources = sources.filter(s => optimisticSourceSlugs.includes(s.config.slug))
                        const displaySources = enabledSources.slice(0, 3)
                        const remainingCount = enabledSources.length - 3
                        return (
                          <>
                            {displaySources.map((source, index) => (
                              <div
                                key={source.config.slug}
                                className={cn("relative h-5 w-5 rounded-[4px] bg-background shadow-minimal flex items-center justify-center", index > 0 && "-ml-1")}
                                style={{ zIndex: index + 1 }}
                              >
                                <SourceAvatar source={source} size="xs" />
                              </div>
                            ))}
                            {remainingCount > 0 && (
                              <div
                                className="-ml-1 h-5 w-5 rounded-[4px] bg-background shadow-minimal flex items-center justify-center text-[8px] font-medium text-muted-foreground"
                                style={{ zIndex: displaySources.length + 1 }}
                              >
                                +{remainingCount}
                              </div>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )
                }
                label={
                  optimisticSourceSlugs.length === 0
                    ? t("chat.sourcesTooltip")
                    : (() => {
                        const enabledSources = sources.filter(s => optimisticSourceSlugs.includes(s.config.slug))
                        if (enabledSources.length === 1) return enabledSources[0].config.name
                        return t("chat.sourcesCount", { count: enabledSources.length })
                      })()
                }
                isExpanded={false}
                hasSelection={optimisticSourceSlugs.length > 0}
                showChevron={false}
                isOpen={sourceDropdownOpen}
                disabled={disabled}
                onClick={() => setSourceDropdownOpen(prev => !prev)}
                tooltip={t("chat.sourcesTooltip")}
              />
              <CompactSourceSelector
                open={sourceDropdownOpen}
                onOpenChange={setSourceDropdownOpen}
                sources={sources}
                selectedSlugs={optimisticSourceSlugs}
                onToggleSlug={(slug) => {
                  const isEnabled = optimisticSourceSlugs.includes(slug)
                  const newSlugs = isEnabled
                    ? optimisticSourceSlugs.filter(currentSlug => currentSlug !== slug)
                    : [...optimisticSourceSlugs, slug]
                  setOptimisticSourceSlugs(newSlugs)
                  onSourcesChange?.(newSlugs)
                }}
              />
            </div>
          )}
          {onWorkingDirectoryChange && (
            <CompactWorkingDirectorySelector
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              sessionFolderPath={sessionFolderPath}
              isEmptySession={false}
              workspaceId={workspaceId}
            />
          )}
          </div>
          )}

          {/* 桌面端：完整的徽章行，含 labels 和工作目录 */}
          {!compactMode && (
          <div className="flex items-center gap-1 min-w-32 shrink overflow-hidden">
          {/* 1. 附件徽章 */}
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attachFiles")
            }
            isExpanded={isEmptySession}
            hasSelection={attachments.length > 0}
            showChevron={false}
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />

          {/* 2. Source 选择器徽章 - 仅在提供 onSourcesChange 时显示 */}
          {onSourcesChange && (
            <div className="relative shrink min-w-0 overflow-hidden">
              <FreeFormInputContextBadge
                buttonRef={sourceButtonRef}
                icon={
                  optimisticSourceSlugs.length === 0 ? (
                    <DatabaseZap className="h-4 w-4" />
                  ) : (
                    <div className="flex items-center -ml-0.5">
                      {(() => {
                        const enabledSources = sources.filter(s => optimisticSourceSlugs.includes(s.config.slug))
                        const displaySources = enabledSources.slice(0, 3)
                        const remainingCount = enabledSources.length - 3
                        return (
                          <>
                            {displaySources.map((source, index) => (
                              <div
                                key={source.config.slug}
                                className={cn("relative h-5 w-5 rounded-[4px] bg-background shadow-minimal flex items-center justify-center", index > 0 && "-ml-1")}
                                style={{ zIndex: index + 1 }}
                              >
                                <SourceAvatar source={source} size="xs" />
                              </div>
                            ))}
                            {remainingCount > 0 && (
                              <div
                                className="-ml-1 h-5 w-5 rounded-[4px] bg-background shadow-minimal flex items-center justify-center text-[8px] font-medium text-muted-foreground"
                                style={{ zIndex: displaySources.length + 1 }}
                              >
                                +{remainingCount}
                              </div>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )
                }
                label={
                  optimisticSourceSlugs.length === 0
                    ? t("chat.chooseSources")
                    : (() => {
                        const enabledSources = sources.filter(s => optimisticSourceSlugs.includes(s.config.slug))
                        if (enabledSources.length === 1) return enabledSources[0].config.name
                        if (enabledSources.length === 2) return enabledSources.map(s => s.config.name).join(', ')
                        return t("chat.sourcesCount", { count: enabledSources.length })
                      })()
                }
                isExpanded={isEmptySession}
                hasSelection={optimisticSourceSlugs.length > 0}
                showChevron={true}
                isOpen={sourceDropdownOpen}
                disabled={disabled}
                data-tutorial="source-selector-button"
                onClick={() => setSourceDropdownOpen(prev => !prev)}
                tooltip={t("chat.sourcesTooltip")}
              />

              <SourceSelectorPopover
                open={sourceDropdownOpen}
                onOpenChange={setSourceDropdownOpen}
                anchorRef={sourceButtonRef}
                sources={sources}
                selectedSlugs={optimisticSourceSlugs}
                onToggleSlug={(slug) => {
                  const isEnabled = optimisticSourceSlugs.includes(slug)
                  const newSlugs = isEnabled
                    ? optimisticSourceSlugs.filter(currentSlug => currentSlug !== slug)
                    : [...optimisticSourceSlugs, slug]
                  setOptimisticSourceSlugs(newSlugs)
                  onSourcesChange?.(newSlugs)
                }}
              />
            </div>
          )}

          {/* 3. 工作目录选择器徽章 */}
          {onWorkingDirectoryChange && (
            <WorkingDirectoryBadge
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              sessionFolderPath={sessionFolderPath}
              isEmptySession={isEmptySession}
              workspaceId={workspaceId}
            />
          )}
          </div>
          )}

          {/* 间隔区：输入框折叠时同时作为点击/悬停目标，
              collapsed during processing in compact mode, so the user can
               */}
          {isCollapsedInCompact ? (
            <button
              type="button"
              onClick={onRequestExpand}
              onMouseEnter={onRequestExpand}
              aria-label={t('chat.tapToType')}
              className="flex-1 h-7 mx-1 flex items-center justify-center text-foreground/30 hover:text-foreground/60 transition-colors cursor-pointer rounded-[6px] hover:bg-foreground/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex-1" />
          )}

          {/* 右侧：模型 + 发送按钮，不允许收缩，始终可见 */}
          <div className="flex items-center shrink-0">
          {/* 5. 模型/连接选择器：compact 模式下隐藏（EditPopover 嵌入场景） */}
          {!compactMode && (
          <DropdownMenu open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "input-toolbar-btn inline-flex items-center h-7 px-1.5 gap-0.5 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none",
                      modelDropdownOpen && "bg-foreground/5",
                      connectionUnavailable && "text-destructive",
                    )}
                  >
                    {connectionUnavailable ? (
                      <>
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        {t('common.unavailable')}
                      </>
                    ) : (
                      <>
                        {effectiveConnectionDetails && llmConnections.length > 1 && storage.get(storage.KEYS.showConnectionIcons, true) && <ConnectionIcon connection={effectiveConnectionDetails} size={14} showTooltip />}
                        {currentModelDisplayName}
                        {pickerMode !== 'locked-single' && <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />}
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('common.model')}
              </TooltipContent>
            </Tooltip>
            <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[260px]">
              {/* 连接不可用提示 */}
              {pickerMode === 'unavailable' ? (
                <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                  <div className="font-medium text-sm mb-1">{t('chat.connectionUnavailable')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('chat.connectionUnavailableDescription')}
                  </div>
                </div>
              ) : pickerMode === 'locked-single' && connectionDefaultModel ? (
                (() => {
                  // 非空会话中的单模型 pi_compat 连接（或只有一个连接、无需切换器时）。

                  // 模型行被禁用（会话已锁定）；图片开关仍可交互。

                  const showVisionToggle =
                    !!effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType)
                  const visionOn = showVisionToggle && modelSupportsImages(effectiveConnectionDetails!, connectionDefaultModel)
                  return (
                    <StyledDropdownMenuItem
                      disabled
                      className="flex items-center justify-between px-2 py-2 rounded-lg"
                    >
                      <div className="text-left">
                        <div className="font-medium text-sm">{stripPiPrefixForDisplay(connectionDefaultModel)}</div>
                        <div className="text-xs text-muted-foreground">{t('chat.connectionDefault')}</div>
                      </div>
                      <div className="flex items-center gap-1 ml-3 shrink-0">
                        {showVisionToggle && effectiveConnectionDetails && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                aria-label={visionOn
                                  ? t('chat.modelPicker.supportsImagesOn')
                                  : t('chat.modelPicker.supportsImagesOff')}
                                className="inline-flex items-center justify-center p-1 rounded pointer-events-auto opacity-100 hover:bg-foreground/5 cursor-pointer"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleToggleModelVision(effectiveConnectionDetails.slug, connectionDefaultModel, !visionOn)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleToggleModelVision(effectiveConnectionDetails.slug, connectionDefaultModel, !visionOn)
                                  }
                                }}
                              >
                                <ImageIcon className={cn(
                                  "h-3.5 w-3.5",
                                  visionOn ? "text-foreground/70" : "text-foreground/30"
                                )} />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {visionOn
                                ? t('chat.modelPicker.supportsImagesOn')
                                : t('chat.modelPicker.supportsImagesOff')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Check className="h-3 w-3 text-foreground" />
                      </div>
                    </StyledDropdownMenuItem>
                  )
                })()
              ) : pickerMode === 'switcher' ? (
                /* Hierarchical view: Provider → Connection → Models (empty session with multiple connections — lets the user switch BEFORE the first message locks the connection) */
                connectionsByProvider.map(([providerName, connections], index) => (
                  <React.Fragment key={providerName}>
                    {/* 提供商分组标签 */}
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide select-none">
                      {providerName}
                    </div>
                    {connections.map((conn) => {
                      const isCurrentConnection = effectiveConnection === conn.slug
                      const isAuthenticated = conn.isAuthenticated
                      return (
                        <DropdownMenuSub key={conn.slug}>
                          <StyledDropdownMenuSubTrigger
                            disabled={!isAuthenticated}
                            className={cn(
                              "flex items-center justify-between px-2 py-2 rounded-lg",
                              isCurrentConnection && "bg-foreground/5"
                            )}
                          >
                            <div className="text-left flex-1">
                              <div className="font-medium text-sm flex items-center gap-1.5">
                                <ConnectionIcon connection={conn} size={14} />
                                {conn.name}
                                {isCurrentConnection && <Check className="h-3 w-3 text-foreground" />}
                              </div>
                              {!isAuthenticated && (
                                <div className="text-xs text-muted-foreground">{t('settings.ai.notAuthenticated')}</div>
                              )}
                            </div>
                          </StyledDropdownMenuSubTrigger>
                          {isAuthenticated && (
                            <StyledDropdownMenuSubContent className="min-w-[220px]">
                              {/* 展示该连接下的模型；回退到提供商默认模型 */}
                              {(conn.models || ANTHROPIC_MODELS).map((model) => {
                                const modelId = typeof model === 'string' ? model : model.id
                                const modelName = typeof model === 'string'
                                  ? stripPiPrefixForDisplay(getModelShortName(model))
                                  : (model.name ?? stripPiPrefixForDisplay(model.id))
                                const isSelectedModel = isCurrentConnection && currentModel === modelId
                                const showVisionToggle = isCompatProvider(conn.providerType)
                                const visionOn = showVisionToggle && modelSupportsImages(conn, modelId)
                                return (
                                  <StyledDropdownMenuItem
                                    key={modelId}
                                    onSelect={() => {
                                      // 如果选择了不同连接，同时更新连接和模型
                                      if (!isCurrentConnection && onConnectionChange) {
                                        onConnectionChange(conn.slug)
                                      }
                                      // 始终同时传递连接和模型，保证持久化正确
                                      onModelChange(modelId, conn.slug)
                                    }}
                                    className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                                  >
                                    <div className="font-medium text-sm">{modelName}</div>
                                    <div className="flex items-center gap-1 ml-3 shrink-0">
                                      {showVisionToggle && (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span
                                              role="button"
                                              tabIndex={0}
                                              aria-label={visionOn
                                                ? t('chat.modelPicker.supportsImagesOn')
                                                : t('chat.modelPicker.supportsImagesOff')}
                                              className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                                              onClick={(e) => {
                                                e.preventDefault()
                                                e.stopPropagation()
                                                handleToggleModelVision(conn.slug, modelId, !visionOn)
                                              }}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                  e.preventDefault()
                                                  e.stopPropagation()
                                                  handleToggleModelVision(conn.slug, modelId, !visionOn)
                                                }
                                              }}
                                            >
                                              <ImageIcon className={cn(
                                                "h-3.5 w-3.5",
                                                visionOn ? "text-foreground/70" : "text-foreground/30"
                                              )} />
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            {visionOn
                                              ? t('chat.modelPicker.supportsImagesOn')
                                              : t('chat.modelPicker.supportsImagesOff')}
                                          </TooltipContent>
                                        </Tooltip>
                                      )}
                                      {isSelectedModel && (
                                        <Check className="h-3 w-3 text-foreground" />
                                      )}
                                    </div>
                                  </StyledDropdownMenuItem>
                                )
                              })}
                            </StyledDropdownMenuSubContent>
                          )}
                        </DropdownMenuSub>
                      )
                    })}
                    {index < connectionsByProvider.length - 1 && (
                      <StyledDropdownMenuSeparator className="my-1" />
                    )}
                  </React.Fragment>
                ))
              ) : (
                /* Flat model list (single connection or session started) */
                <>
                  {/* 指示当前正在使用哪个连接 */}
                  {!isEmptySession && currentConnectionDetails && llmConnections.length > 1 && (
                    <>
                      <div className="flex items-center gap-2 px-2 py-1.5 text-xs select-none text-muted-foreground">
                        <span>{t('chat.usingConnection', { name: currentConnectionDetails.name })}</span>
                      </div>
                      <StyledDropdownMenuSeparator className="my-1" />
                    </>
                  )}
                  {/* 根据实际连接提供商类型显示的模型选项 */}
                  {availableModels.map((model) => {
                    const modelId = typeof model === 'string' ? model : model.id
                    const modelName = typeof model === 'string'
                      ? stripPiPrefixForDisplay(getModelShortName(model))
                      : (model.name ?? stripPiPrefixForDisplay(model.id))
                    const isSelected = currentModel === modelId
                    const descriptionKey = typeof model !== 'string' && 'descriptionKey' in model ? (model.descriptionKey as string) : undefined
                    const description = descriptionKey ? t(descriptionKey) : (typeof model !== 'string' && 'description' in model ? (model.description as string) : '')
                    const showVisionToggle =
                      !!effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType)
                    const visionOn = showVisionToggle && modelSupportsImages(effectiveConnectionDetails!, modelId)
                    return (
                      <StyledDropdownMenuItem
                        key={modelId}
                        onSelect={() => onModelChange(modelId, effectiveConnection)}
                        className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                      >
                        <div className="text-left">
                          <div className="font-medium text-sm">{modelName}</div>
                          {description && (
                            <div className="text-xs text-muted-foreground">{description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 ml-3 shrink-0">
                          {showVisionToggle && effectiveConnectionDetails && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  aria-label={visionOn
                                    ? t('chat.modelPicker.supportsImagesOn')
                                    : t('chat.modelPicker.supportsImagesOff')}
                                  className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleToggleModelVision(effectiveConnectionDetails.slug, modelId, !visionOn)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      handleToggleModelVision(effectiveConnectionDetails.slug, modelId, !visionOn)
                                    }
                                  }}
                                >
                                  <ImageIcon className={cn(
                                    "h-3.5 w-3.5",
                                    visionOn ? "text-foreground/70" : "text-foreground/30"
                                  )} />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {visionOn
                                  ? t('chat.modelPicker.supportsImagesOn')
                                  : t('chat.modelPicker.supportsImagesOff')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {isSelected && (
                            <Check className="h-3 w-3 text-foreground" />
                          )}
                        </div>
                      </StyledDropdownMenuItem>
                    )
                  })}
                </>
              )}

              {/* 思考等级选择器：仅在模型支持思考等级时显示
                  （Claude 支持扩展思考，OpenAI 后端可能不支持） */}
              {availableThinkingLevels.length > 0 && (
                <>
                  <StyledDropdownMenuSeparator className="my-1" />

                  <DropdownMenuSub>
                    <StyledDropdownMenuSubTrigger disabled={thinkingDisabled} className={cn("flex items-center justify-between px-2 py-2 rounded-lg", thinkingDisabled && "opacity-50 cursor-not-allowed")}>
                      <div className="text-left flex-1">
                        <div className="font-medium text-sm">{t(getThinkingLevelNameKey(thinkingLevel))}</div>
                        <div className="text-xs text-muted-foreground">{thinkingDisabled ? t('thinking.notSupported') : t('thinking.extendedDesc')}</div>
                      </div>
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent className="min-w-[220px]">
                      {availableThinkingLevels.map(({ id, nameKey, descriptionKey }) => {
                        const isSelected = thinkingLevel === id
                        return (
                          <StyledDropdownMenuItem
                            key={id}
                            onSelect={() => onThinkingLevelChange?.(id)}
                            className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                          >
                            <div className="text-left">
                              <div className="font-medium text-sm">{t(nameKey)}</div>
                              <div className="text-xs text-muted-foreground">{t(descriptionKey)}</div>
                            </div>
                            {isSelected && (
                              <Check className="h-3 w-3 text-foreground shrink-0 ml-3" />
                            )}
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}

              {/* 上下文用量页脚：只有拿到 token 数据时才显示 */}
              {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
                <>
                  <StyledDropdownMenuSeparator className="my-1" />
                  <div className="px-2 py-1.5 select-none">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t('chat.context')}</span>
                      <span className="flex items-center gap-1.5">
                        {contextStatus.isCompacting && (
                          <Spinner className="h-3 w-3" />
                        )}
                        {t('chat.tokensUsed', { displayCount: formatTokenCount(contextStatus.inputTokens) })}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </StyledDropdownMenuContent>
          </DropdownMenu>
          )}

          {/* 5.5 上下文用量警告徽章：接近自动压缩阈值时显示 */}
          {(() => {
            // 根据压缩阈值（约上下文窗口的 77.5%）计算使用百分比，
            // 而不是完整上下文窗口：在触发压缩前给用户有意义的预警。
            // SDK 在 200k 上下文窗口下约 155k tokens 时触发压缩。
            // SDK 尚未报告用量时，回退到已知的各模型上下文窗口。
            const effectiveContextWindow = contextStatus?.contextWindow || getModelContextWindow(currentModel)
            const compactionThreshold = effectiveContextWindow
              ? Math.round(effectiveContextWindow * 0.775)
              : null
            const usagePercent = contextStatus?.inputTokens && compactionThreshold
              ? Math.min(99, Math.round((contextStatus.inputTokens / compactionThreshold) * 100))
              : null
            // 当用量达到压缩阈值的 80% 且当前未在压缩时显示徽章
            // Codex 和 Copilot 模型不支持上下文压缩，隐藏徽章
            const showWarning = usagePercent !== null && usagePercent >= 80 && !contextStatus?.isCompacting

            if (!showWarning) return null

            const handleCompactClick = () => {
              if (!isProcessing) {
                onSubmit('/compact', [])
              }
            }

            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCompactClick}
                    disabled={isProcessing}
                    className="inline-flex items-center h-6 px-2 text-[12px] font-medium bg-info/10 rounded-[6px] shadow-tinted select-none cursor-pointer hover:bg-info/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      '--shadow-color': 'var(--info-rgb)',
                      color: 'color-mix(in oklab, var(--info) 30%, var(--foreground))',
                    } as React.CSSProperties}
                  >
                    {usagePercent}%
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isProcessing
                    ? `${usagePercent}% context used — wait for current operation`
                    : `${usagePercent}% context used — click to compact`
                  }
                </TooltipContent>
              </Tooltip>
            )
          })()}

          {/* 6. 发送/停止按钮：处理中始终显示停止 */}
          {isProcessing ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label={t('chat.stopResponse')}
              className="send-btn h-7 w-7 rounded-full shrink-0 hover:bg-foreground/15 active:bg-foreground/20 ml-2"
              onClick={() => handleStop(false)}
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              aria-label={t('shortcuts.sendMessage')}
              className="send-btn h-7 w-7 rounded-full shrink-0 ml-2"
              disabled={!hasContent || disabled || disableSend}
              data-tutorial="send-button"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          </div>
          </div>
        </div>
      </div>
    </form>
  )
}

/**
 * WorkingDirectoryBadge - chat-input trigger for the shared WorkingDirectorySelector.
 *
 * Renders the context-badge trigger; the picker popover + folder state machine
 * live in {@link WorkingDirectorySelector} so the Tasks editor reuses the same
 * picker (and can supply its own trigger).
 */
function WorkingDirectoryBadge({
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  isEmptySession = false,
  workspaceId,
}: {
  workingDirectory?: string
  onWorkingDirectoryChange: (path: string) => void
  sessionFolderPath?: string
  isEmptySession?: boolean
  workspaceId?: string
}) {
  const { t } = useTranslation()
  return (
    <WorkingDirectorySelector
      workingDirectory={workingDirectory}
      onWorkingDirectoryChange={onWorkingDirectoryChange}
      sessionFolderPath={sessionFolderPath}
      workspaceId={workspaceId}
      renderTrigger={({ open, hasFolder, folderName, workingDirectory: wd, homeDir, gitBranch }) => (
        <span className="shrink min-w-0 overflow-hidden">
          <FreeFormInputContextBadge
            icon={<Icon_Home className="h-4 w-4" />}
            label={folderName ?? t('chat.workInFolder')}
            isExpanded={isEmptySession}
            hasSelection={hasFolder}
            showChevron={true}
            isOpen={open}
            tooltip={
              hasFolder ? (
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{t("chat.workingDirectory")}</span>
                  <span className="text-xs opacity-70">{formatPathForDisplay(wd, homeDir)}</span>
                  {gitBranch && <span className="text-xs opacity-70">{t("chat.onBranch", { branch: gitBranch })}</span>}
                </span>
              ) : t("chat.chooseWorkingDirectory")
            }
          />
        </span>
      )}
    />
  )
}
