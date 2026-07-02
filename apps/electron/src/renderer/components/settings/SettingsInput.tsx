/**
 * SettingsInput
 *
 * 设置页文本输入组件，带标签和描述。
 * 支持普通文本、密码、邮箱、URL 等类型，并内置密码显示/隐藏切换。
 */

import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsInputProps {
  /** 输入框标签 */
  label?: string
  /** 标签下方的描述说明 */
  description?: string
  /** 当前输入值 */
  value: string
  /** 值变化时的回调 */
  onChange: (value: string) => void
  /** 占位提示 */
  placeholder?: string
  /** 输入框类型 */
  type?: 'text' | 'password' | 'email' | 'url'
  /** 是否禁用 */
  disabled?: boolean
  /** 错误提示 */
  error?: string
  /** 输入框右侧的操作按钮 */
  action?: React.ReactNode
  /** 额外 className */
  className?: string
  /** 是否在卡片内部 */
  inCard?: boolean
  /** 失去焦点时的回调 */
  onBlur?: () => void
  /** 键盘按下事件回调 */
  onKeyDown?: (e: React.KeyboardEvent) => void
}

/**
 * SettingsInput - 带标签的文本输入框
 *
 * @example
 * <SettingsInput
 *   label="Name"
 *   value={name}
 *   onChange={setName}
 *   placeholder="Enter your name..."
 * />
 */
export function SettingsInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  error,
  action,
  className,
  inCard = false,
  onBlur,
  onKeyDown,
}: SettingsInputProps) {
  const id = React.useId()
  // 控制密码是否明文显示
  const [showPassword, setShowPassword] = React.useState(false)
  const isPassword = type === 'password'
  // 密码框在显示状态下临时变成 text 类型，否则保持原类型
  const inputType = isPassword && showPassword ? 'text' : type

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
      <div className="flex gap-2">
        <div className={cn(
          'relative flex-1 rounded-md shadow-minimal has-[:focus-visible]:bg-background',
          error && 'ring-1 ring-destructive'
        )}>
          <Input
            id={id}
            type={inputType}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            className={cn(
              'bg-muted/50 border-0 shadow-none focus-visible:ring-0 focus-visible:outline-none focus-visible:bg-transparent',
              isPassword && 'pr-10'
            )}
          />
          {isPassword && (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          )}
        </div>
        {action}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

/**
 * SettingsInputRow - 标签在左、输入框在右的横向布局
 *
 * 适合在一行里同时展示说明和输入控件。
 */
export interface SettingsInputRowProps {
  /** 行标签 */
  label: string
  /** 标签下方的描述说明 */
  description?: string
  /** 当前输入值 */
  value: string
  /** 值变化时的回调 */
  onChange: (value: string) => void
  /** 占位提示 */
  placeholder?: string
  /** 输入框类型 */
  type?: 'text' | 'password' | 'email' | 'url'
  /** 是否禁用 */
  disabled?: boolean
  /** 错误提示 */
  error?: string
  /** 额外 className */
  className?: string
  /** 是否在卡片内部 */
  inCard?: boolean
}

export function SettingsInputRow({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  error,
  className,
  inCard = true,
}: SettingsInputRowProps) {
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
        {error && <p className={cn('text-sm text-destructive', settingsUI.labelDescriptionGap)}>{error}</p>}
      </div>
      <div data-layout="settings-control" className={cn(
        'ml-4 shrink-0 rounded-md shadow-minimal has-[:focus-visible]:bg-background',
        error && 'ring-1 ring-destructive'
      )}>
        <Input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-[200px] bg-muted/50 border-0 shadow-none focus-visible:ring-0 focus-visible:outline-none focus-visible:bg-transparent"
        />
      </div>
    </div>
  )
}

/**
 * SettingsSecretInput - 密码/密钥输入框
 *
 * 专门用于 API key、token 等敏感信息，带显示/隐藏切换和错误提示。
 */
export interface SettingsSecretInputProps {
  /** 输入框标签 */
  label?: string
  /** 描述说明 */
  description?: string
  /** 当前输入值 */
  value: string
  /** 值变化时的回调 */
  onChange: (value: string) => void
  /** 占位提示 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 错误提示 */
  error?: string
  /** 额外 className */
  className?: string
  /** 是否在卡片内部 */
  inCard?: boolean
  /** 失去焦点时的回调 */
  onBlur?: () => void
}

export function SettingsSecretInput({
  label,
  description,
  value,
  onChange,
  placeholder = 'Enter value...',
  disabled,
  error,
  className,
  inCard = false,
  onBlur,
}: SettingsSecretInputProps) {
  const id = React.useId()
  const [showValue, setShowValue] = React.useState(false)

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
        'relative rounded-md shadow-minimal bg-muted/50 has-[:focus-visible]:bg-background',
        error && 'ring-1 ring-destructive'
      )}>
        <Input
          id={id}
          type={showValue ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onBlur={onBlur}
          className="pr-10 bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={() => setShowValue(!showValue)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          tabIndex={-1}
        >
          {showValue ? (
            <EyeOff className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
        </button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
