/**
 * LabelValuePopover — 编辑 Label 类型值或移除 Label 的弹窗
 *
 * Label 是给 Session 打标签用的元数据，比如优先级、截止日期等。
 * 点击 LabelBadge 后弹出此组件：
 * - 根据 valueType（number/string/date/link）显示不同的值编辑器
 * - 提供“移除”按钮，把 Label 从 Session 上 detach
 *
 * Enter 或失焦时提交修改；Escape 取消并关闭。
 * 布尔类型 Label（没有 valueType）只显示移除按钮。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, CalendarDays, ExternalLink } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './popover'
import { Calendar } from './calendar'
import { cn } from '@/lib/utils'
import { openLabelLink } from '@/lib/open-label-link'
import { parseDate } from 'chrono-node'
import { format, parse } from 'date-fns'
import type { LabelConfig } from '@craft-agent/shared/labels'

export interface LabelValuePopoverProps {
  /** Label 配置（颜色、名称、值类型） */
  label: LabelConfig
  /** 当前原始值字符串 */
  value?: string
  /** 用户提交新值时调用（Enter 或失焦） */
  onValueChange?: (newValue: string | undefined) => void
  /** 用户点击“移除”时调用 */
  onRemove?: () => void
  /** 受控的打开状态 */
  open: boolean
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void
  /** 所属 Session ID，用于关闭后把焦点还回原输入框 */
  sessionId?: string
  /** 触发元素（通常是 LabelBadge） */
  children: React.ReactNode
}

/** Label 值编辑/移除弹窗 */
export function LabelValuePopover({
  label,
  value,
  onValueChange,
  onRemove,
  open,
  onOpenChange,
  sessionId,
  children,
}: LabelValuePopoverProps) {
  const { t } = useTranslation()
  // 本地草稿值，弹窗打开时从 props.value 重置
  const [draft, setDraft] = React.useState(value ?? '')
  // 是否显示内联日历选择器（仅 date 类型 Label）
  const [calendarOpen, setCalendarOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const removeButtonRef = React.useRef<HTMLButtonElement>(null)

  // 弹窗打开或 value 变化时同步草稿。
  // 如果是 date 类型且已有 YYYY-MM-DD 值，显示成人类可读格式。
  React.useEffect(() => {
    if (open) {
      setCalendarOpen(false)
      if (label.valueType === 'date' && value) {
        try {
          const parsed = parse(value, 'yyyy-MM-dd', new Date())
          setDraft(format(parsed, 'MMMM d, yyyy'))
        } catch {
          setDraft(value)
        }
      } else {
        setDraft(value ?? '')
      }
    }
  }, [open, value, label.valueType])

  /**
   * 弹窗打开时自动移动焦点。
   * 有 valueType 的 Label 聚焦到值输入框；布尔 Label 聚焦到移除按钮。
   * 阻止 Radix 默认行为，以便精确控制焦点位置。
   */
  const handleOpenAutoFocus = React.useCallback((e: Event) => {
    e.preventDefault()
    if (label.valueType) {
      inputRef.current?.focus()
    } else {
      removeButtonRef.current?.focus()
    }
  }, [label.valueType])

  /**
   * 弹窗关闭后把焦点还给聊天输入框。
   * 与 ActiveOptionBadges 中的处理方式一致。
   */
  const handleCloseAutoFocus = React.useCallback((e: Event) => {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('craft:focus-input', {
      detail: { sessionId }
    }))
  }, [sessionId])

  /** 提交当前草稿值 */
  const commitValue = React.useCallback(() => {
    const trimmed = draft.trim()
    // 空字符串表示清空值（Label 退化为纯布尔标签）
    onValueChange?.(trimmed || undefined)
  }, [draft, onValueChange])

  /** 值输入框的键盘处理 */
  const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitValue()
      onOpenChange(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(value ?? '')
      onOpenChange(false)
    }
  }, [commitValue, onOpenChange, value])

  /**
   * 对 date 类型 Label：用 chrono-node 解析草稿文本，得到解析后的 Date。
   * 无法解析时返回 null。
   */
  const parsedDate = React.useMemo(() => {
    if (label.valueType !== 'date' || !draft.trim()) return null
    return parseDate(draft.trim())
  }, [label.valueType, draft])

  // 日历中高亮显示的日期：优先用实时解析出的 draft，
  // 回退到已提交 value（YYYY-MM-DD 格式）。
  const calendarDate = React.useMemo(() => {
    if (parsedDate) return parsedDate
    if (label.valueType === 'date' && value) {
      try {
        return parse(value, 'yyyy-MM-dd', new Date())
      } catch {
        return undefined
      }
    }
    return undefined
  }, [parsedDate, label.valueType, value])

  /** date 输入框的键盘处理 */
  const handleDateKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (parsedDate) {
        // 提交解析后的日期并关闭
        onValueChange?.(format(parsedDate, 'yyyy-MM-dd'))
        onOpenChange(false)
      } else if (!draft.trim()) {
        // 空输入则清空值
        onValueChange?.(undefined)
        onOpenChange(false)
      }
      // 无法解析的非空文本保持弹窗打开
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(value ?? '')
      onOpenChange(false)
    }
  }, [parsedDate, draft, onOpenChange, onValueChange, value])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-56 p-0"
        onOpenAutoFocus={handleOpenAutoFocus}
        onCloseAutoFocus={handleCloseAutoFocus}
        // 阻止 pointer 事件冒泡到 React 合成事件树，
        // 否则弹窗内的事件会冒到 Session 按钮的 onMouseDown，导致误选 Session。
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* date 类型值编辑器：自然语言输入 + 嵌套日历弹窗 */}
        {label.valueType === 'date' && (
          <div className="px-1.5 py-1.5 border-b border-border/50">
            {/* 左侧文本输入，右侧日历图标触发嵌套 popover */}
            <div className="flex items-center gap-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                  }}
                  onKeyDown={(e) => {
                    // 按 ↓ 打开日历（与 shadcn 一致）
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setCalendarOpen(true)
                    } else {
                      handleDateKeyDown(e)
                    }
                  }}
                  onBlur={() => {
                    // 失焦时提交解析出的日期，空则清空
                    if (parsedDate) {
                      onValueChange?.(format(parsedDate, 'yyyy-MM-dd'))
                    } else if (!draft.trim()) {
                      onValueChange?.(undefined)
                    }
                  }}
                  placeholder="tomorrow, next friday..."
                  className={cn(
                    'flex-1 h-7 px-2 text-[13px]',
                    'bg-transparent',
                    'text-foreground placeholder:text-foreground/30',
                    'outline-none'
                  )}
                />
                {/* 日历图标打开嵌套的日期选择 popover */}
                <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('labels.selectDate')}
                      className={cn(
                        'flex items-center justify-center w-7 h-7 rounded-[5px]',
                        'hover:bg-foreground/5 transition-colors cursor-pointer',
                        'outline-none',
                        calendarOpen && 'bg-foreground/5'
                      )}
                    >
                      <CalendarDays className="w-3.5 h-3.5 text-foreground/50" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[220px] overflow-hidden p-0"
                    side="top"
                    align="end"
                    sideOffset={8}
                  >
                    <Calendar
                      mode="single"
                      selected={calendarDate}
                      captionLayout="dropdown"
                      defaultMonth={calendarDate}
                      onSelect={(date) => {
                        if (date) {
                          // 直接提交并更新草稿显示
                          onValueChange?.(format(date, 'yyyy-MM-dd'))
                          setDraft(format(date, 'MMMM d, yyyy'))
                          setCalendarOpen(false)
                        }
                      }}
                    />
                  </PopoverContent>
                </Popover>
            </div>
            {/* 解析成功时在输入框下方显示解析结果 */}
            {parsedDate && (
              <div className="px-2 text-[11px] text-foreground/50">
                {format(parsedDate, 'EEE, MMM d, yyyy')}
              </div>
            )}
          </div>
        )}

        {/* 非 date 类型的值编辑器（number/string/link） */}
        {label.valueType && label.valueType !== 'date' && (
          <div className="px-1.5 py-1.5 border-b border-border/50">
            <input
              ref={inputRef}
              type={label.valueType === 'number' ? 'number' : 'text'}
              step={label.valueType === 'number' ? 'any' : undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitValue}
              placeholder={label.valueType === 'number' ? 'Enter number...' : label.valueType === 'link' ? 'Enter URL...' : 'Enter value...'}
              className={cn(
                'w-full h-7 px-2 text-[13px]',
                'bg-transparent',
                'text-foreground placeholder:text-foreground/30',
                'outline-none'
              )}
            />
          </div>
        )}

        {/* 操作区：link 类型显示“打开链接”，下面是“移除” */}
        <div className="p-1">
          {label.valueType === 'link' && value && (
            <button
              type="button"
              onClick={() => {
                openLabelLink(value)
                onOpenChange(false)
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-[4px]',
                'text-[13px] text-foreground',
                'hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]',
                'transition-colors cursor-pointer outline-none'
              )}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>{t('common.openLink')}</span>
            </button>
          )}
          <button
            ref={removeButtonRef}
            type="button"
            onClick={() => {
              onRemove?.()
              onOpenChange(false)
            }}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-[4px]',
              'text-[13px] text-destructive',
              'hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]',
              'transition-colors cursor-pointer outline-none'
            )}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t('common.remove')}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
