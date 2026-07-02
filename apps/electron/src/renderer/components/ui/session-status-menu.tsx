/**
 * SessionStatusMenu —— Session 工作流状态下拉菜单
 *
 * 用于选择或切换 Session 的状态（如 backlog/todo/done），并支持归档/取消归档入口。
 * 基于 cmdk 的 Command 组件实现可过滤的命令列表。
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from 'cmdk'
import { Archive, ArchiveRestore, Ban } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type SessionStatusId,
  type SessionStatus,
  getStateIcon,
  getStateColor,
  getStatusIconStyle,
} from '@/config/session-status-config'

// 为了向后兼容重新导出类型
export { type SessionStatusId, type SessionStatus, getStateIcon, getStateColor }

// ============================================================================
// 共享样式（与 slash-command-menu 保持一致）
// ============================================================================

const MENU_CONTAINER_STYLE = 'min-w-[180px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-1.5 text-[13px]'

// ============================================================================
// StateItemContent —— 共用的状态项渲染
// ============================================================================

const DEFAULT_STATUS_IDS = new Set(['backlog', 'todo', 'needs-review', 'done', 'cancelled'])

function StateItemContent({ state }: { state: SessionStatus }) {
  const { t } = useTranslation()
  const label = DEFAULT_STATUS_IDS.has(state.id) ? t(`status.${state.id}`, state.label) : state.label
  return (
    <>
      <span className="shrink-0 flex items-center" style={getStatusIconStyle(state)}>
        {state.icon}
      </span>
      <div className="flex-1 min-w-0">{label}</div>
    </>
  )
}

// ============================================================================
// SessionStatusMenu 组件 —— 选择/切换 Session 状态
// ============================================================================

/** SessionStatusMenu 的 props 类型 */
export interface SessionStatusMenuProps {
  states?: SessionStatus[]
  activeState: SessionStatusId
  onSelect: (stateId: SessionStatusId) => void
  /** 当前 Session 是否已归档 */
  isArchived?: boolean
  /** 归档操作 —— 未归档且提供该回调时显示“归档”项 */
  onArchive?: () => void
  /** 取消归档操作 —— 已归档且提供该回调时显示“取消归档”项 */
  onUnarchive?: () => void
  /** 清除操作 —— 提供该回调时在底部显示"清除"项（例如"不更改状态"） */
  onClear?: () => void
  /** 清除项的标签文本，默认为 "Clear" */
  clearLabel?: string
  className?: string
}

/** Session 状态选择菜单 */
export function SessionStatusMenu({
  states = [],
  activeState,
  onSelect,
  isArchived,
  onArchive,
  onUnarchive,
  onClear,
  clearLabel,
  className,
}: SessionStatusMenuProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 菜单打开时聚焦过滤输入框
  React.useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  // 默认选中当前激活状态，否则选中第一项
  const defaultValue = activeState || states[0]?.id

  return (
    <CommandPrimitive
      className={cn(MENU_CONTAINER_STYLE, className)}
      defaultValue={defaultValue}
    >
      <div className="border-b border-border/50 px-3 py-2">
        <CommandPrimitive.Input
          ref={inputRef}
          value={filter}
          onValueChange={setFilter}
          placeholder={t("status.filterStatuses")}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <CommandPrimitive.List className={MENU_LIST_STYLE}>
        <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
          No status found
        </CommandPrimitive.Empty>
        {states.map((state) => {
          const isActive = activeState === state.id
          return (
            <CommandPrimitive.Item
              key={state.id}
              value={state.label}
              onSelect={() => onSelect(state.id)}
              className={cn(
                MENU_ITEM_STYLE,
                'outline-none',
                isActive ? 'bg-foreground/7' : 'data-[selected=true]:bg-foreground/3'
              )}
            >
              <StateItemContent state={state} />
            </CommandPrimitive.Item>
          )
        })}
        {/* 清除项 —— 只在提供了回调且无过滤词时显示 */}
        {!filter && onClear && (
          <>
            <div className="border-t border-border/50 mx-2 my-1" />
            <CommandPrimitive.Item
              value="clear-status"
              onSelect={() => onClear()}
              className={cn(
                MENU_ITEM_STYLE,
                'outline-none',
                !activeState ? 'bg-foreground/7' : 'data-[selected=true]:bg-foreground/3'
              )}
            >
              <span className="shrink-0 flex items-center opacity-60">
                <Ban className="w-3.5 h-3.5" />
              </span>
              <div className="flex-1 min-w-0">{clearLabel ?? 'Clear'}</div>
            </CommandPrimitive.Item>
          </>
        )}
        {/* 归档/取消归档项 —— 只在提供了对应回调且无过滤词时显示 */}
        {!filter && (isArchived ? onUnarchive : onArchive) && (
          <>
            <div className="border-t border-border/50 mx-2 my-1" />
            <CommandPrimitive.Item
              value={isArchived ? "unarchive" : "archive"}
              onSelect={() => isArchived ? onUnarchive?.() : onArchive?.()}
              className={cn(
                MENU_ITEM_STYLE,
                'outline-none',
                'data-[selected=true]:bg-foreground/3'
              )}
            >
              <span className="shrink-0 flex items-center opacity-60">
                {isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              </span>
              <div className="flex-1 min-w-0">{isArchived ? 'Unarchive' : 'Archive'}</div>
            </CommandPrimitive.Item>
          </>
        )}
      </CommandPrimitive.List>
    </CommandPrimitive>
  )
}
