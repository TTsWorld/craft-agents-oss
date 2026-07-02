/**
 * SettingsMenuSelect
 *
 * 菜单式下拉选择组件，支持选项描述和搜索过滤。
 * 基于 Radix Popover 实现，自带碰撞检测和可访问性。
 * 选项数量超过阈值时会自动启用搜索。
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsMenuSelectOption {
  /** 选项值 */
  value: string
  /** 展示标签 */
  label: string
  /** 选项描述/副标题 */
  description?: string
}

export interface SettingsMenuSelectProps {
  /** 当前选中的值 */
  value: string
  /** 选中值变化时的回调 */
  onValueChange: (value: string) => void
  /** 可选列表 */
  options: SettingsMenuSelectOption[]
  /** 未选中时的占位提示 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 触发按钮的额外 className */
  className?: string
  /** 下拉菜单宽度 */
  menuWidth?: number
  /** 鼠标悬停在某选项上时的回调（用于实时预览），离开传 null */
  onHover?: (value: string | null) => void
  /** 是否启用搜索（默认选项 > 8 时自动启用） */
  searchable?: boolean
  /** 搜索框占位提示 */
  searchPlaceholder?: string
}

/**
 * SettingsMenuSelect - 菜单式下拉选择器
 *
 * 使用 Radix Popover 做定位和碰撞检测。
 * 当选项超过 8 个或显式开启 searchable 时，会显示搜索框。
 */
export function SettingsMenuSelect({
  value,
  onValueChange,
  options,
  placeholder = 'Select...',
  disabled,
  className,
  menuWidth = 280,
  onHover,
  searchable,
  searchPlaceholder,
}: SettingsMenuSelectProps) {
  const { t } = useTranslation()
  const effectiveSearchPlaceholder = searchPlaceholder ?? t("common.search")
  const [isOpen, setIsOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  const selectedOption = options.find((o) => o.value === value)

  // 显式启用搜索，或选项较多时自动启用
  const showSearch = searchable ?? options.length > 8

  // 根据搜索词过滤选项
  const filteredOptions = React.useMemo(() => {
    if (!searchQuery.trim()) return options
    const query = searchQuery.toLowerCase()
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(query) ||
        option.value.toLowerCase().includes(query) ||
        option.description?.toLowerCase().includes(query)
    )
  }, [options, searchQuery])

  const handleSelect = (optionValue: string) => {
    onValueChange(optionValue)
    setIsOpen(false)
    setSearchQuery('')
    // 选中后清除预览状态，因为真实值已确定
    onHover?.(null)
  }

  // Popover 关闭时（点击外部、按 ESC 等）清除预览和搜索词
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (!open) {
      onHover?.(null)
      setSearchQuery('')
    } else if (showSearch) {
      // 打开时聚焦搜索框
      setTimeout(() => searchInputRef.current?.focus(), 0)
    }
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            'inline-flex items-center h-8 px-3 gap-1 text-sm rounded-lg',
            'bg-background shadow-minimal',
            'hover:bg-foreground/[0.02] transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            isOpen && 'bg-foreground/[0.02]',
            className
          )}
        >
          <span className="truncate">{selectedOption?.label || placeholder}</span>
          <ChevronDown className="opacity-50 shrink-0 size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className="p-1.5"
        style={{ width: menuWidth }}
        onMouseLeave={() => onHover?.(null)}
      >
        {showSearch && (
          <div className="relative mb-1.5">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={effectiveSearchPlaceholder}
              className={cn(
                'w-full h-8 pl-8 pr-3 text-sm rounded-md',
                'bg-foreground/5 border-0',
                'placeholder:text-muted-foreground/50',
                'focus:outline-none focus:ring-1 focus:ring-foreground/20'
              )}
            />
          </div>
        )}
        <div className="space-y-0.5 max-h-64 overflow-auto">
          {filteredOptions.length === 0 ? (
            <div className="px-2.5 py-3 text-sm text-muted-foreground text-center">
              No results found
            </div>
          ) : (
            filteredOptions.map((option) => {
              const isSelected = value === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  onMouseEnter={() => onHover?.(option.value)}
                  className={cn(
                    'w-full flex items-center justify-between px-2.5 py-2 rounded-lg',
                    'hover:bg-foreground/5 transition-colors text-left',
                    isSelected && 'bg-foreground/3'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className={settingsUI.label}>{option.label}</div>
                    {option.description && (
                      <div className={cn(settingsUI.descriptionSmall, settingsUI.labelDescriptionGap)}>
                        {option.description}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <Check className="size-4 text-foreground shrink-0 ml-3" />
                  )}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * SettingsMenuSelectRow - 标签在左、菜单选择在右的横向布局
 */
export interface SettingsMenuSelectRowProps {
  /** 行标签 */
  label: string
  /** 标签下方的描述说明 */
  description?: string
  /** 当前选中的值 */
  value: string
  /** 选中值变化时的回调 */
  onValueChange: (value: string) => void
  /** 可选列表 */
  options: SettingsMenuSelectOption[]
  /** 占位提示 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 额外 className */
  className?: string
  /** 是否在卡片内部 */
  inCard?: boolean
  /** 下拉菜单宽度 */
  menuWidth?: number
  /** 悬停预览回调，离开传 null */
  onHover?: (value: string | null) => void
  /** 是否启用搜索 */
  searchable?: boolean
  /** 搜索框占位提示 */
  searchPlaceholder?: string
}

export function SettingsMenuSelectRow({
  label,
  description,
  value,
  onValueChange,
  options,
  placeholder = 'Select...',
  disabled,
  className,
  inCard = true,
  menuWidth = 280,
  onHover,
  searchable,
  searchPlaceholder,
}: SettingsMenuSelectRowProps) {
  return (
    <div
      data-layout="settings-row"
      className={cn(
        'flex items-center justify-between',
        inCard ? 'px-4 py-3.5' : 'py-3',
        className
      )}
    >
      <div className="flex-1 min-w-0">
        <div className={settingsUI.label}>{label}</div>
        {description && (
          <p className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</p>
        )}
      </div>
      <div data-layout="settings-control" className="ml-4 shrink-0">
        <SettingsMenuSelect
          value={value}
          onValueChange={onValueChange}
          options={options}
          placeholder={placeholder}
          disabled={disabled}
          menuWidth={menuWidth}
          onHover={onHover}
          searchable={searchable}
          searchPlaceholder={searchPlaceholder}
        />
      </div>
    </div>
  )
}
