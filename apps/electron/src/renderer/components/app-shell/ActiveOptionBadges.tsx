/**
 * ActiveOptionBadges - 输入区上方的一排活动选项徽章。
 *
 * 包括：权限模式、工作流状态、标签徽章，以及右侧的会话信息入口。
 * 这些徽章让用户一眼看到当前会话的配置，并可以快速修改。
 */
import * as React from 'react'
import { useTranslation } from "react-i18next"
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SlashCommandMenu, DEFAULT_SLASH_COMMAND_GROUPS, type SlashCommandId } from '@/components/ui/slash-command-menu'
import { ChevronDown, Info } from 'lucide-react'
import { PERMISSION_MODE_CONFIG, type PermissionMode } from '@craft-agent/shared/agent/modes'
import { ActiveTasksBar, type BackgroundTask } from './ActiveTasksBar'
import type { TerminalOverlayData } from './TaskActionMenu'
import { LabelIcon, LabelValueTypeIcon } from '@/components/ui/label-icon'
import { LabelValuePopover } from '@/components/ui/label-value-popover'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { flattenLabels, parseLabelEntry, formatLabelEntry, formatDisplayValue } from '@craft-agent/shared/labels'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import { useTheme } from '@/context/ThemeContext'
import { useDynamicStack } from '@/hooks/useDynamicStack'
import type { SessionStatus } from '@/config/session-status-config'
import { getState } from '@/config/session-status-config'
import { SessionStatusMenu } from '@/components/ui/session-status-menu'
import { MetadataBadge } from '@/components/ui/metadata-badge'
import { openLabelLink } from '@/lib/open-label-link'
import { SessionInfoPopover } from './SessionInfoPopover'

// ============================================================================
// 权限模式图标组件
// ============================================================================

function PermissionModeIcon({ mode, className }: { mode: PermissionMode; className?: string }) {
  const config = PERMISSION_MODE_CONFIG[mode]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}

/** ActiveOptionBadgesProps：组件 props 类型定义 */
export interface ActiveOptionBadgesProps {
  /** 当前权限模式（safe / ask / allow-all） */
  permissionMode?: PermissionMode
  /** 权限模式改变时的回调 */
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** 要展示的后台任务 */
  tasks?: BackgroundTask[]
  /** 当前会话 ID，用于打开预览窗口 */
  sessionId?: string
  /** 会话文件夹绝对路径（右侧 Files 入口用） */
  sessionFolderPath?: string
  /** 终止任务时的回调 */
  onKillTask?: (taskId: string) => void
  /** 向输入框插入文本的回调 */
  onInsertMessage?: (text: string) => void
  /** 在终端浮层中展示任务输出的回调（可选） */
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  /** 当前会话已应用的标签条目，例如 ["bug", "priority::3"] */
  sessionLabels?: string[]
  /** 可用的标签配置树，用于把标签 ID 解析成可显示对象 */
  labels?: LabelConfig[]
  /** 移除标签的回调（旧接口，优先用 onLabelsChange） */
  onRemoveLabel?: (labelId: string) => void
  /** 标签数组变化（修改值或移除）时的回调 */
  onLabelsChange?: (updatedLabels: string[]) => void
  /** 需要自动打开值编辑浮层的标签 ID（通过 # 菜单新增带值标签时设置） */
  autoOpenLabelId?: string | null
  /** 自动打开信号被消费后调用，父组件可据此清空该信号 */
  onAutoOpenConsumed?: () => void
  // ── 状态徽章（也放在动态堆叠区） ──
  /** 可用工作流状态列表 */
  sessionStatuses?: SessionStatus[]
  /** 当前会话状态 ID */
  currentSessionStatus?: string
  /** 状态改变时的回调 */
  onSessionStatusChange?: (stateId: string) => void
  /** 额外的 CSS 类名 */
  className?: string
}

/** 解析后的标签条目：配置 + 原始值 + 在 sessionLabels 中的下标 */
interface ResolvedLabelEntry {
  config: LabelConfig
  rawValue?: string
  index: number
}

/** ActiveOptionBadges - 活动选项徽章容器 */
export function ActiveOptionBadges({
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  onShowTerminalOverlay,
  sessionLabels = [],
  labels = [],
  onRemoveLabel,
  onLabelsChange,
  autoOpenLabelId,
  onAutoOpenConsumed,
  sessionStatuses = [],
  currentSessionStatus,
  onSessionStatusChange,
  className,
}: ActiveOptionBadgesProps) {
  // 把 sessionLabels 里的条目解析成标签配置对象 + 原始值。
  // 条目可能是裸 ID（"bug"）或带值（"priority::3"），保留原始下标方便编辑/删除。
  const resolvedLabels = React.useMemo((): ResolvedLabelEntry[] => {
    if (sessionLabels.length === 0 || labels.length === 0) return []
    const flat = flattenLabels(labels)
    const result: ResolvedLabelEntry[] = []
    for (let i = 0; i < sessionLabels.length; i++) {
      const parsed = parseLabelEntry(sessionLabels[i])
      const config = flat.find(l => l.id === parsed.id)
      if (config) {
        result.push({ config, rawValue: parsed.rawValue, index: i })
      }
    }
    return result
  }, [sessionLabels, labels])

  const hasLabels = resolvedLabels.length > 0

  // 从 sessionStatuses 里解析当前状态用于徽章展示。
  // 每个会话总有状态；未显式设置时回退到 'todo'，和 SessionList 行为保持一致。
  const effectiveStateId = currentSessionStatus || 'todo'
  const resolvedState = sessionStatuses.length > 0 ? getState(effectiveStateId, sessionStatuses) : undefined
  const hasState = !!resolvedState

  // 有标签时才需要堆叠容器（状态徽章单独放在左侧，不参与堆叠）
  const hasStackContent = hasLabels

  // 动态堆叠：ResizeObserver 直接计算每个子徽章的 marginLeft。
  // 越宽的徽章负边距越大，保证堆叠后露出的可见条宽度一致；不需要 React re-render。
  const stackRef = useDynamicStack({ gap: 8, minVisible: 20, reservedStart: 0 })

  // 没有任何徽章或任务时不渲染
  if (!permissionMode && tasks.length === 0 && !hasState && !hasStackContent) {
    return null
  }

  return (
    <>
      {/* Background tasks row — running / done / orphaned chips. Rendered above the
       * options row so a growing number of tasks wraps without disturbing the
       * mode/label badges. Only present when there are active/recent tasks. */}
      {tasks.length > 0 && sessionId && (
        <div className="flex items-center flex-wrap gap-2 mb-2 px-px">
          <ActiveTasksBar
            tasks={tasks}
            sessionId={sessionId}
            onKillTask={onKillTask}
            onInsertMessage={onInsertMessage}
            onShowTerminalOverlay={onShowTerminalOverlay}
          />
        </div>
      )}

    <div className={cn("flex items-start gap-2 mb-2 px-px pt-px pb-0.5", className)}>
      {/* 左侧：权限模式 → 状态 → 标签堆叠 */}
      <div className="flex items-start gap-2 min-w-0 flex-1">
        {/* 权限模式徽章 */}
        {permissionMode && (
          <div className="shrink-0">
            <PermissionModeDropdown
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* 状态徽章——单独放在左侧，紧跟模式徽章 */}
        {hasState && resolvedState && (
          <div className="shrink-0">
            <StateBadge
              state={resolvedState}
              sessionStatuses={sessionStatuses}
              onSessionStatusChange={onSessionStatusChange}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* 标签徽章堆叠容器（左侧）。
         * useDynamicStack 通过 ResizeObserver 直接设置每个子元素的 marginLeft。
         * overflow: clip 防止滚动，同时 py/-my 给阴影留出绘制空间。 */}
        {hasStackContent && (
          <div
            className="flex-1 min-w-0 max-w-full py-0.5 -my-0.5"
            style={{
              // 用 drop-shadow 模拟 shadow-minimal（描边透明 alpha，不会被裁剪）。
              // 光环用较大 blur+opacity 模拟可见边框；模糊阴影用较小 blur+opacity 保持紧凑。
              filter: 'drop-shadow(0px 0px 0.5px rgba(var(--foreground-rgb), 0.3)) drop-shadow(0px 1px 0.1px rgba(0,0,0,0.04)) drop-shadow(0px 3px 0.2px rgba(0,0,0,0.03))',
            }}
          >
            <div
              ref={stackRef}
              className="flex items-center min-w-0 py-1 -my-1"
              style={{ overflow: 'clip' }}
            >
              {/* 标签徽章列表 */}
              {resolvedLabels.map(({ config, rawValue, index }) => (
                <LabelBadge
                  key={`${config.id}-${index}`}
                  label={config}
                  value={rawValue}
                  autoOpen={config.id === autoOpenLabelId}
                  onAutoOpenConsumed={onAutoOpenConsumed}
                  sessionId={sessionId}
                  onValueChange={(newValue) => {
                    // 用新值重建对应下标的标签条目
                    const updated = [...sessionLabels]
                    updated[index] = formatLabelEntry(config.id, newValue)
                    onLabelsChange?.(updated)
                  }}
                  onRemove={() => {
                    if (onLabelsChange) {
                      onLabelsChange(sessionLabels.filter((_, i) => i !== index))
                    } else {
                      onRemoveLabel?.(config.id)
                    }
                  }}
                />
              ))}
            </div>
          </div>
        )}

      </div>

      {/* 右侧：会话信息入口 */}
      <div className="shrink-0">
        <FilesPopoverButton sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </div>
    </div>
    </>
  )
}

// ============================================================================
// 标签徽章组件
// ============================================================================

/**
 * LabelBadge - 单个标签徽章，带 LabelValuePopover 用于编辑/删除。
 * 徽章本身不设置 box-shadow，所有阴影来自父容器的 drop-shadow 滤镜，
 * 这样可以沿着遮罩后的 alpha 描边，不会被裁剪。
 * 展示形式：[颜色圆点] [名称] [· 等宽值] [下拉箭头]
 */
function LabelBadge({
  label,
  value,
  autoOpen,
  onAutoOpenConsumed,
  onValueChange,
  onRemove,
  sessionId,
}: {
  label: LabelConfig
  value?: string
  /** 为 true 时挂载后自动打开值编辑浮层（用于刚新增的带值标签） */
  autoOpen?: boolean
  onAutoOpenConsumed?: () => void
  onValueChange?: (newValue: string | undefined) => void
  onRemove: () => void
  sessionId?: string
}) {
  const { isDark } = useTheme()
  const [open, setOpen] = React.useState(false)

  // 当标签刚通过 # 菜单新增且带 valueType 时，自动打开值编辑浮层；只触发一次，随后清除信号。
  React.useEffect(() => {
    if (autoOpen && label.valueType) {
      setOpen(true)
      onAutoOpenConsumed?.()
    }
  }, [autoOpen, label.valueType, onAutoOpenConsumed])

  // 解析标签颜色，用于通过 CSS color-mix 给背景和文字着色
  const resolvedColor = label.color
    ? resolveEntityColor(label.color, isDark)
    : 'var(--foreground)'

  const displayValue = value ? formatDisplayValue(value, label.valueType) : undefined

  return (
    <LabelValuePopover
      label={label}
      value={value}
      open={open}
      onOpenChange={setOpen}
      onValueChange={onValueChange}
      onRemove={onRemove}
      sessionId={sessionId}
    >
      <MetadataBadge
        label={label.name}
        value={displayValue}
        onValueClick={label.valueType === 'link' && value ? () => openLabelLink(value) : undefined}
        icon={<LabelIcon label={label} size="lg" />}
        valueHintIcon={label.valueType ? <LabelValueTypeIcon valueType={label.valueType} /> : undefined}
        badgeColor={resolvedColor}
        interactive
        isActive={open}
        showChevron
        shadow="none"
        className="relative"
      />
    </LabelValuePopover>
  )
}

// ============================================================================
// 状态徽章组件
// ============================================================================

/**
 * StateBadge - 把当前工作流状态渲染成徽章。
 * 点击弹出 SessionStatusMenu 修改状态；样式与标签徽章保持一致。
 */
function StateBadge({
  state,
  sessionStatuses,
  onSessionStatusChange,
  sessionId,
}: {
  state: SessionStatus
  sessionStatuses: SessionStatus[]
  onSessionStatusChange?: (stateId: string) => void
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const handleSelect = React.useCallback((stateId: string) => {
    setOpen(false)
    onSessionStatusChange?.(stateId)
  }, [onSessionStatusChange])

  // 使用状态解析后的颜色着色（和标签徽章使用同一套 color-mix 模式）
  const badgeColor = state.resolvedColor || 'var(--foreground)'
  const applyColor = state.iconColorable

  // 默认状态 ID 走 i18n 翻译；自定义状态直接显示 label
  const DEFAULT_STATUS_IDS = new Set(['backlog', 'todo', 'needs-review', 'done', 'cancelled'])
  const stateLabel = DEFAULT_STATUS_IDS.has(state.id) ? t(`status.${state.id}`, state.label) : state.label

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <MetadataBadge
          label={stateLabel}
          badgeColor={badgeColor}
          interactive
          isActive={open}
          showChevron
          icon={(
            <span
              className="shrink-0 flex items-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full [&>img]:w-full [&>img]:h-full [&>span]:text-xs"
              style={applyColor ? { color: state.resolvedColor } : undefined}
            >
              {state.icon}
            </span>
          )}
          className="pl-2.5"
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-0 shadow-none bg-transparent"
        side="top"
        align="end"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          // 关闭浮层后聚焦输入框，但阻止 Radix 默认的自动聚焦行为
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('craft:focus-input', {
            detail: { sessionId }
          }))
        }}
      >
        <SessionStatusMenu
          activeState={state.id}
          onSelect={handleSelect}
          states={sessionStatuses}
        />
      </PopoverContent>
    </Popover>
  )
}

function FilesPopoverButton({ sessionId, sessionFolderPath }: { sessionId?: string; sessionFolderPath?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  if (!sessionId) return null

  return (
    <SessionInfoPopover
      sessionId={sessionId}
      sessionFolderPath={sessionFolderPath}
      trigger={(
        <button
          type="button"
          className={cn(
            "h-[30px] pl-[12px] pr-[14px] text-xs font-medium rounded-[8px] flex items-center gap-1.5 shrink-0",
            "outline-none select-none transition-colors shadow-minimal",
            "hover:bg-foreground/5 data-[state=open]:bg-foreground/5",
            "bg-[color-mix(in_srgb,var(--background)_97%,var(--foreground)_3%)]",
            "text-foreground/80",
          )}
        >
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-nowrap">{t("common.info")}</span>
        </button>
      )}
    />
  )
}

interface PermissionModeDropdownProps {
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  sessionId?: string
}

function PermissionModeDropdown({ permissionMode, onPermissionModeChange, sessionId }: PermissionModeDropdownProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // 乐观本地状态：UI 立即更新，等后端确认后再与 prop 同步
  const [optimisticMode, setOptimisticMode] = React.useState(permissionMode)

  // 当 prop 变化（后端确认）时同步回乐观状态
  React.useEffect(() => {
    setOptimisticMode(permissionMode)
  }, [permissionMode])

  const activeCommands = React.useMemo((): SlashCommandId[] => {
    return [optimisticMode as SlashCommandId]
  }, [optimisticMode])

  // 下拉菜单里选择新模式
  const handleSelect = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe' || commandId === 'ask' || commandId === 'allow-all') {
      setOptimisticMode(commandId)
      onPermissionModeChange?.(commandId)
    }
    setOpen(false)
  }, [onPermissionModeChange])

  // 用乐观状态取当前模式配置，实现即时 UI 反馈
  const config = PERMISSION_MODE_CONFIG[optimisticMode]

  // 各模式的主题感知样式
  // - safe（Explore）：前景色 60% 透明度，低调只读感
  // - ask（Ask to Edit）：info 色，提示需要确认
  // - allow-all（Auto）：accent 色，完全自主
  const modeStyles: Record<PermissionMode, { className: string; shadowVar: string }> = {
    'safe': {
      className: 'bg-foreground/5 text-foreground/60',
      shadowVar: 'var(--foreground-rgb)',
    },
    'ask': {
      className: 'bg-info/10 text-info',
      shadowVar: 'var(--info-rgb)',
    },
    'allow-all': {
      className: 'bg-accent/5 text-accent',
      shadowVar: 'var(--accent-rgb)',
    },
  }
  const currentStyle = modeStyles[optimisticMode]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-tutorial="permission-mode-dropdown"
          className={cn(
            "h-[30px] pl-2.5 pr-2 text-xs font-medium rounded-[8px] flex items-center gap-1.5 shadow-tinted outline-none select-none",
            currentStyle.className
          )}
          style={{ '--shadow-color': currentStyle.shadowVar } as React.CSSProperties}
        >
          <PermissionModeIcon mode={optimisticMode} className="h-3.5 w-3.5" />
          <span>{t(`mode.${optimisticMode}`)}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[8px] bg-background text-foreground shadow-modal-small"
        side="top"
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // 触摸设备上不要自动聚焦输入框，否则会弹出虚拟键盘
          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
          if (!isTouchDevice) {
            window.dispatchEvent(new CustomEvent('craft:focus-input', {
              detail: { sessionId }
            }))
          }
        }}
      >
        <SlashCommandMenu
          commandGroups={DEFAULT_SLASH_COMMAND_GROUPS}
          activeCommands={activeCommands}
          onSelect={handleSelect}
          showFilter
        />
      </PopoverContent>
    </Popover>
  )
}

