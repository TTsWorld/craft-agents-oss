/**
 * SettingsSelect
 *
 * 设置页专用的下拉选择组件，带标签和描述。
 * 基于 shadcn/ui 的 Select 做了一层样式封装。
 */

import * as React from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

// 下拉选项的单个配置（类似 Go 里定义一个结构体字段）
export interface SettingsSelectOption {
  /** 选项值，通常传给 onValueChange */
  value: string
  /** 选项在界面上显示的文本 */
  label: string
}

export interface SettingsSelectProps {
  /** 标签文本 */
  label?: string
  /** 标签下方的描述说明 */
  description?: string
  /** 当前选中的值 */
  value: string
  /** 选中值变化时的回调函数（TS 里的 handler，类似 Go 的 func 参数） */
  onValueChange: (value: string) => void
  /** 可选列表 */
  options: SettingsSelectOption[]
  /** 未选中时的占位提示 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 外层容器的额外 className */
  className?: string
  /** 是否在 SettingsCard 内部，决定 padding 大小 */
  inCard?: boolean
}

/**
 * SettingsSelect - 带标签的下拉选择器
 *
 * @example
 * <SettingsSelect
 *   label="Timezone"
 *   value={timezone}
 *   onValueChange={setTimezone}
 *   options={timezoneOptions}
 *   placeholder="Select timezone..."
 * />
 */
export function SettingsSelect({
  label,
  description,
  value,
  onValueChange,
  options,
  placeholder = 'Select...',
  disabled,
  className,
  inCard = false,
}: SettingsSelectProps) {
  // React 提供的唯一 id，用来把 Label 和 Select 关联起来（a11y 类似 htmlFor + id）
  const id = React.useId()

  return (
    <div
      className={cn(
        'space-y-2',
        inCard && 'px-4 py-3.5',
        className
      )}
    >
      {label && (
        <div className={settingsUI.labelGroup}>
          <Label htmlFor={id} className={settingsUI.label}>
            {label}
          </Label>
          {description && (
            <p className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</p>
          )}
        </div>
      )}
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full bg-muted/50">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * SettingsSelectRow - 标签在左、选择器在右的横向布局
 *
 * 适合在一行里同时展示说明和选择控件。
 */
export interface SettingsSelectRowProps {
  /** 行标签 */
  label: string
  /** 标签下方的描述说明 */
  description?: string
  /** 当前选中的值 */
  value: string
  /** 选中值变化时的回调 */
  onValueChange: (value: string) => void
  /** 可选列表 */
  options: SettingsSelectOption[]
  /** 占位提示 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 额外 className */
  className?: string
  /** 是否在卡片内部 */
  inCard?: boolean
}

export function SettingsSelectRow({
  label,
  description,
  value,
  onValueChange,
  options,
  placeholder = 'Select...',
  disabled,
  className,
  inCard = true,
}: SettingsSelectRowProps) {
  const id = React.useId()

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
        <Label htmlFor={id} className={settingsUI.label}>
          {label}
        </Label>
        {description && (
          <p className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</p>
        )}
      </div>
      <div data-layout="settings-control" className="ml-4 shrink-0">
        <Select value={value} onValueChange={onValueChange} disabled={disabled}>
          <SelectTrigger id={id} className="w-[180px] bg-muted/50">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
