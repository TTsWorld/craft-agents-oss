/**
 * SettingsRadioGroup & SettingsRadioCard
 *
 * 全宽卡片式单选组件（Amie 风格）。
 * 每个选项都是一张独立卡片，左侧有单选指示器。
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

// ============================================
// Context：在 RadioGroup 和 RadioCard 之间共享状态
// ============================================

interface RadioGroupContextValue {
  /** 当前选中的值 */
  value: string
  /** 选中变化时的回调 */
  onValueChange: (value: string) => void
}

// React Context：类似 Go 里把依赖往下传，但这里是跨组件共享状态
const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null)

function useRadioGroupContext() {
  return React.useContext(RadioGroupContext)
}

// ============================================
// SettingsRadioGroup
// ============================================

export interface SettingsRadioGroupProps<T extends string = string> {
  /** 当前选中的值 */
  value: T
  /** 选中变化时的回调 */
  onValueChange: (value: T) => void
  /** 单选卡片子元素 */
  children: React.ReactNode
  /** 额外 className */
  className?: string
}

/**
 * SettingsRadioGroup - 单选卡片组的容器
 *
 * @example
 * <SettingsRadioGroup value={model} onValueChange={setModel}>
 *   <SettingsRadioCard value="opus" label="Opus 4.8" description="Most capable" />
 *   <SettingsRadioCard value="sonnet" label="Sonnet 4.6" description="Balanced" />
 * </SettingsRadioGroup>
 */
export function SettingsRadioGroup<T extends string = string>({
  value,
  onValueChange,
  children,
  className,
}: SettingsRadioGroupProps<T>) {
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <RadioGroupContext.Provider
      value={{
        value,
        onValueChange: onValueChange as (value: string) => void,
      }}
    >
      <div
        role="radiogroup"
        className={cn(
          'rounded-xl bg-background shadow-minimal overflow-hidden',
          className
        )}
      >
        {childArray.map((child, index) => (
          <React.Fragment key={index}>
            {index > 0 && <div className="h-px bg-border/50 mx-4" />}
            {child}
          </React.Fragment>
        ))}
      </div>
    </RadioGroupContext.Provider>
  )
}

// ============================================
// SettingsRadioCard
// ============================================

export interface SettingsRadioCardProps {
  /** 选项值 */
  value: string
  /** 选项标签 */
  label: string
  /** 选项描述 */
  description?: string
  /** 右侧图标 */
  icon?: React.ReactNode
  /** 选项徽章（例如 "Active"、"Beta"） */
  badge?: React.ReactNode
  /** 是否禁用 */
  disabled?: boolean
  /** 选中时展开的额外内容 */
  expandedContent?: React.ReactNode
  /** 额外 className */
  className?: string
  /** 独立模式：是否被选中（不依赖 RadioGroup） */
  selected?: boolean
  /** 独立模式：点击回调 */
  onClick?: () => void
  /** 为 true 时禁用卡片背景（用于放在 SettingsCard 内部） */
  inCard?: boolean
}

/**
 * SettingsRadioCard - 全宽单选卡片
 *
 * @example
 * <SettingsRadioCard
 *   value="api_key"
 *   label="API Key"
 *   description="Pay-as-you-go with your Anthropic key"
 *   expandedContent={<ApiKeyInput />}
 * />
 */
export function SettingsRadioCard({
  value,
  label,
  description,
  icon,
  badge,
  disabled,
  expandedContent,
  className,
  selected,
  onClick,
  inCard,
}: SettingsRadioCardProps) {
  const context = useRadioGroupContext()
  // 同时支持在 RadioGroup 内使用，或独立使用
  const isSelected = context ? context.value === value : (selected ?? false)
  const handleClick = context ? () => context.onValueChange(value) : onClick
  const id = React.useId()

  // 只有在独立模式且不在 SettingsCard 内部时，才需要自带卡片样式
  const needsCardStyling = !context && !inCard

  return (
    <div
      className={cn(
        'overflow-hidden transition-colors',
        needsCardStyling && 'rounded-xl shadow-minimal bg-background',
        !disabled && 'hover:bg-foreground-3',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <button
        type="button"
        role="radio"
        id={id}
        aria-checked={isSelected}
        disabled={disabled}
        onClick={() => !disabled && handleClick?.()}
        className={cn(
          'w-full px-4 py-3.5 text-left flex items-start gap-3',
          !disabled && 'cursor-pointer'
        )}
      >
        {/* 单选圆圈 */}
        <div
          className={cn(
            'w-4 h-4 rounded-full border-[1.5px] mt-[3px] shrink-0',
            'grid place-items-center transition-colors',
            isSelected
              ? 'border-foreground bg-foreground'
              : 'border-muted-foreground/40'
          )}
        >
          {isSelected && (
            <div className="w-2 h-2 rounded-full bg-background" />
          )}
        </div>

        {/* 内容区 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={settingsUI.label}>{label}</span>
            {badge}
          </div>
          {description && (
            <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>
              {description}
            </div>
          )}
        </div>

        {/* 右侧图标 */}
        {icon && <div className="shrink-0 ml-2">{icon}</div>}
      </button>

      {/* 展开内容：选中时以动画高度展开 */}
      <AnimatePresence initial={false}>
        {isSelected && expandedContent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-0">
              <div className="pl-[30px]">{expandedContent}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// SettingsRadioOption（更轻量的行内单选）
// ============================================

export interface SettingsRadioOptionProps {
  /** 选项值 */
  value: string
  /** 选项标签 */
  label: string
  /** 行内描述（用 "·" 分隔） */
  description?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 额外 className */
  className?: string
}

/**
 * SettingsRadioOption - 简单行内单选项（无独立卡片背景）
 *
 * 放在 SettingsCard 内使用，可在分组中展示多个选项而不带各自的背景。
 */
export function SettingsRadioOption({
  value,
  label,
  description,
  disabled,
  className,
}: SettingsRadioOptionProps) {
  const context = useRadioGroupContext()
  if (!context) {
    throw new Error('SettingsRadioOption must be used within SettingsRadioGroup')
  }
  const { value: selectedValue, onValueChange } = context
  const isSelected = selectedValue === value
  const id = React.useId()

  return (
    <button
      type="button"
      role="radio"
      id={id}
      aria-checked={isSelected}
      disabled={disabled}
      onClick={() => !disabled && onValueChange(value)}
      className={cn(
        'w-full px-4 py-3 text-left flex items-center gap-3',
        'hover:bg-muted/50 transition-colors',
        disabled && 'opacity-50 cursor-not-allowed',
        !disabled && 'cursor-pointer',
        className
      )}
    >
      {/* 单选圆圈 */}
      <div
        className={cn(
          'w-4 h-4 rounded-full border-[1.5px] shrink-0',
          'grid place-items-center transition-colors',
          isSelected
            ? 'border-foreground bg-foreground'
            : 'border-muted-foreground/40'
        )}
      >
        {isSelected && (
          <div className="w-2 h-2 rounded-full bg-background" />
        )}
      </div>

      {/* 标签区 */}
      <div className="flex-1 min-w-0 flex items-center">
        <span className="text-sm">{label}</span>
        {description && (
          <span className="text-sm text-muted-foreground ml-1.5">
            · {description}
          </span>
        )}
      </div>
    </button>
  )
}
