/**
 * SettingsTextarea
 *
 * 设置页多行文本输入组件，带标签、描述和可选字数统计。
 */

import * as React from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsTextareaProps {
  /** 文本域标签 */
  label?: string
  /** 标签下方的描述说明 */
  description?: string
  /** 当前输入值 */
  value: string
  /** 值变化时的回调 */
  onChange: (value: string) => void
  /** 占位提示 */
  placeholder?: string
  /** 最大字符长度 */
  maxLength?: number
  /** 可见行数 */
  rows?: number
  /** 是否禁用 */
  disabled?: boolean
  /** 错误提示 */
  error?: string
  /** 额外 className */
  className?: string
  /** 是否在卡片内部 */
  inCard?: boolean
}

/**
 * SettingsTextarea - 带字数统计的多行文本输入框
 *
 * @example
 * <SettingsTextarea
 *   label="Notes"
 *   description="Additional context for the AI assistant"
 *   value={notes}
 *   onChange={setNotes}
 *   maxLength={2000}
 *   rows={4}
 * />
 */
export function SettingsTextarea({
  label,
  description,
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 4,
  disabled,
  error,
  className,
  inCard = false,
}: SettingsTextareaProps) {
  const id = React.useId()
  const charCount = value.length
  // 是否超出最大长度限制
  const isOverLimit = maxLength !== undefined && charCount > maxLength

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
      <div className={cn(
        'relative rounded-md shadow-minimal has-[:focus-visible]:bg-background',
        error && 'ring-1 ring-destructive',
        isOverLimit && 'ring-1 ring-destructive'
      )}>
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          className={cn(
            'bg-muted/50 border-0 shadow-none resize-y min-h-[120px] focus-visible:ring-0 focus-visible:outline-none focus-visible:bg-transparent',
            maxLength && 'pb-6'
          )}
        />
        {maxLength !== undefined && (
          <div
            className={cn(
              'absolute bottom-2 right-3 text-xs',
              isOverLimit ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {charCount}/{maxLength}
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
