/**
 * LabelMenu — 输入框中的 #Label / State 自动完成菜单
 *
 * 用户在输入框里输入 # 时触发，显示可过滤的 Label（标签）和 State（工作流状态）列表。
 * 如果传了 states，菜单上方会显示“States”分组，下方是“Labels”分组。
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LabelIcon } from './label-icon'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { createLabelMenuItems, filterItems, segmentScore, type LabelMenuItem } from './label-menu-utils'
import { getStatusIconStyle, type SessionStatus } from '@/config/session-status-config'

export { createLabelMenuItems, filterItems, type LabelMenuItem } from './label-menu-utils'

// ============================================================================
// 类型
// ============================================================================

export interface InlineLabelMenuProps {
  /** 菜单是否打开 */
  open: boolean
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void
  /** Label 菜单项 */
  items: LabelMenuItem[]
  /** 选择 Label 时调用 */
  onSelect: (labelId: string) => void
  /** 用户选择“Add New Label”时调用，传入当前 filter 文本作为预填充 */
  onAddLabel?: (prefill: string) => void
  /** 当前过滤文本 */
  filter?: string
  /** 菜单位置 */
  position: { x: number; y: number }
  /** 额外 className */
  className?: string
  // ── 状态选择（可选，传了会显示 States 分组）──
  /** 菜单中显示的工作流状态 */
  states?: SessionStatus[]
  /** 当前激活的状态 ID（显示勾选） */
  activeStateId?: string
  /** 选择状态时调用 */
  onSelectState?: (stateId: string) => void
}

// ============================================================================
// 共享样式（与 slash-command-menu、mention-menu 保持一致）
// ============================================================================

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-2.5 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'

// ============================================================================
// 过滤工具
// ============================================================================

/**
 * 按状态标签文本做简单过滤。
 * 与 Label 过滤共用 segmentScore 逻辑，保证一致性。
 */
export function filterSessionStatuses(states: SessionStatus[], filter: string): SessionStatus[] {
  if (!filter) return states

  const segments = filter.toLowerCase().split('/').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return states

  // States 是平级（无层级），所以只用第一个 segment 匹配标签
  const segment = segments[0]
  const scored: { state: SessionStatus; score: number }[] = []

  for (const state of states) {
    const score = segmentScore(state.label, segment)
    if (score > 0) {
      scored.push({ state, score })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.state.label.localeCompare(b.state.label))
  return scored.map(s => s.state)
}

// ============================================================================
// InlineLabelMenu 组件
// ============================================================================

/**
 * 内联 Label/State 自动完成菜单。
 * 输入框中输入 # 触发，显示在光标上方，支持跨 States 和 Labels 分组的键盘导航。
 */
export function InlineLabelMenu({
  open,
  onOpenChange,
  items,
  onSelect,
  onAddLabel,
  filter = '',
  position,
  className,
  states = [],
  activeStateId,
  onSelectState,
}: InlineLabelMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredItems = filterItems(items, filter)
  const filteredStates_ = filterSessionStatuses(states, filter)

  // 构建统一的扁平索引用于键盘导航：
  // [0..filteredStates_.length-1] = states，[filteredStates_.length..] = labels
  const totalItemCount = filteredStates_.length + filteredItems.length

  // 没有任何匹配项但提供了 onAddLabel 时，显示“Add New Label”行
  const showAddLabel = totalItemCount === 0 && !!onAddLabel

  // filter 变化时重置选中项
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // 选中项滚动到可视区域
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // 键盘导航（跨 States 和 Labels 统一处理）
  React.useEffect(() => {
    if (!open) return
    if (totalItemCount === 0 && !showAddLabel) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          if (!showAddLabel) {
            setSelectedIndex(prev => (prev < totalItemCount - 1 ? prev + 1 : 0))
          }
          break
        case 'ArrowUp':
          e.preventDefault()
          if (!showAddLabel) {
            setSelectedIndex(prev => (prev > 0 ? prev - 1 : totalItemCount - 1))
          }
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (showAddLabel) {
            onAddLabel?.(filter)
            onOpenChange(false)
          } else if (selectedIndex < filteredStates_.length) {
            // 选中的是 state
            onSelectState?.(filteredStates_[selectedIndex].id)
            onOpenChange(false)
          } else {
            // 选中的是 label
            const labelIndex = selectedIndex - filteredStates_.length
            if (filteredItems[labelIndex]) {
              onSelect(filteredItems[labelIndex].id)
              onOpenChange(false)
            }
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, filteredStates_, filteredItems, totalItemCount, selectedIndex, onSelect, onSelectState, onAddLabel, onOpenChange, showAddLabel, filter])

  // 点击外部关闭
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  // 未打开或无匹配项且无“Add New Label”回退时不渲染
  if (!open || (totalItemCount === 0 && !showAddLabel)) return null

  // 菜单位于光标上方
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  // 只有同时存在 states 和 labels 时才显示分组标题
  const showSectionHeaders = filteredStates_.length > 0 && filteredItems.length > 0

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{ left: Math.round(position.x) - 10, bottom: bottomPosition, minWidth: 200, maxWidth: 260 }}
    >
      <div ref={listRef} className={MENU_LIST_STYLE}>
        {showAddLabel ? (
          /* 没有匹配项时显示“Add New Label”回退行 */
          <div
            data-selected="true"
            onClick={() => {
              onAddLabel?.(filter)
              onOpenChange(false)
            }}
            className={cn(MENU_ITEM_STYLE, MENU_ITEM_SELECTED)}
          >
            <div className="shrink-0 text-muted-foreground">
              <Plus className="h-3.5 w-3.5" />
            </div>
            <span className="text-[13px]">{t('sidebarMenu.addNewLabel')}</span>
          </div>
        ) : (
          <>
            {/* ── States 分组 ── */}
            {filteredStates_.length > 0 && (
              <>
                {showSectionHeaders && (
                  <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                    States
                  </div>
                )}
                {filteredStates_.map((state, index) => {
                  const isSelected = index === selectedIndex
                  const isActive = state.id === activeStateId
                  return (
                    <div
                      key={`state-${state.id}`}
                      data-selected={isSelected}
                      onClick={() => {
                        onSelectState?.(state.id)
                        onOpenChange(false)
                      }}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={cn(
                        MENU_ITEM_STYLE,
                        isSelected && MENU_ITEM_SELECTED,
                        isActive && 'bg-foreground/7',
                      )}
                    >
                      {/* 带解析颜色的状态图标 */}
                      <span
                        className="shrink-0 flex items-center w-4 h-4 [&>svg]:w-full [&>svg]:h-full [&>img]:w-full [&>img]:h-full [&>span]:text-sm"
                        style={getStatusIconStyle(state)}
                      >
                        {state.icon}
                      </span>
                      <div className="flex-1 min-w-0 truncate">{state.label}</div>
                      {/* 激活状态显示勾选 */}
                      {isActive && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </div>
                  )
                })}
              </>
            )}

            {/* ── 分组分隔线 ── */}
            {showSectionHeaders && (
              <div className="my-1 mx-2 border-t border-border/40" />
            )}

            {/* ── Labels 分组 ── */}
            {filteredItems.length > 0 && (
              <>
                {showSectionHeaders && (
                  <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                    Labels
                  </div>
                )}
                {filteredItems.map((item, index) => {
                  // 在统一索引中加上 state 数量偏移
                  const flatIndex = filteredStates_.length + index
                  const isSelected = flatIndex === selectedIndex
                  return (
                    <div
                      key={item.id}
                      data-selected={isSelected}
                      onClick={() => {
                        onSelect(item.id)
                        onOpenChange(false)
                      }}
                      onMouseEnter={() => setSelectedIndex(flatIndex)}
                      className={cn(
                        MENU_ITEM_STYLE,
                        isSelected && MENU_ITEM_SELECTED
                      )}
                    >
                      {/* Label 图标 */}
                      <LabelIcon label={item.config} size="lg" />
                      {/* Label 名称，可选父路径 */}
                      <div className="flex-1 min-w-0 truncate">
                        {item.parentPath && (
                          <span className="text-muted-foreground">{item.parentPath}</span>
                        )}
                        <span>{item.label}</span>
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Hook: useInlineLabelMenu
// ============================================================================

/** Interface for elements compatible with this hook */
export interface LabelMenuInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

/** UseInlineLabelMenuOptions：选项类型定义 */
export interface UseInlineLabelMenuOptions {
  /** Ref to the input element */
  inputRef: React.RefObject<LabelMenuInputElement | null>
  /** Available labels (tree structure) */
  labels: LabelConfig[]
  /** Already-applied labels on the session (to exclude from menu) */
  sessionLabels?: string[]
  /** Callback when a label is selected */
  onSelect: (labelId: string) => void
  // ── State selection (optional — enables states in the # menu) ──
  /** Available workflow states */
  sessionStatuses?: SessionStatus[]
  /** Currently active state ID */
  activeStateId?: string
}

/** UseInlineLabelMenuReturn：类型定义 */
export interface UseInlineLabelMenuReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  items: LabelMenuItem[]
  /** Workflow states passed through for the menu component */
  states: SessionStatus[]
  /** Currently active state ID */
  activeStateId?: string
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  /** Returns the cleaned input text after removing the #trigger text */
  handleSelect: (labelId: string) => string
}

/**
 * Hook that manages inline label/state menu state.
 * Detects # trigger in input text and shows a filterable menu of available labels and states.
 * Already-applied labels are excluded from the menu to prevent duplicates.
 */
export function useInlineLabelMenu({
  inputRef,
  labels,
  sessionLabels = [],
  onSelect,
  sessionStatuses = [],
  activeStateId,
}: UseInlineLabelMenuOptions): UseInlineLabelMenuReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [hashStart, setHashStart] = React.useState(-1)
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Build flat menu items from label tree, excluding already-applied labels
  const items = React.useMemo(
    () => createLabelMenuItems(labels, sessionLabels),
    [labels, sessionLabels],
  )

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // Match # at start of input or after whitespace, followed by optional filter text
    const hashMatch = textBeforeCursor.match(/(?:^|\s)#([\w\-\/]*)$/)

    if (hashMatch) {
      const filterText = hashMatch[1] || ''

      const matchStart = textBeforeCursor.lastIndexOf('#')
      setHashStart(matchStart)
      setFilter(filterText)

      if (inputRef.current) {
        // Try to get actual caret position
        const caretRect = inputRef.current.getCaretRect?.()
        if (caretRect && caretRect.x > 0) {
          setPosition({ x: caretRect.x, y: caretRect.y })
        } else {
          // Fallback: position at input element's left edge
          const rect = inputRef.current.getBoundingClientRect()
          const lineHeight = 20
          const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
          setPosition({
            x: rect.left,
            y: rect.top + (linesBeforeCursor + 1) * lineHeight,
          })
        }
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setHashStart(-1)
    }
  }, [inputRef, items])

  // Handle label selection: remove #trigger text from input, call onSelect
  const handleSelect = React.useCallback((labelId: string): string => {
    let result = ''
    if (hashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, hashStart)
      const after = currentValue.slice(cursorPosition)
      result = (before + after).trim()
    }

    onSelect(labelId)
    setIsOpen(false)

    return result
  }, [onSelect, hashStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setHashStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    items,
    states: sessionStatuses,
    activeStateId,
    handleInputChange,
    close,
    handleSelect,
  }
}
