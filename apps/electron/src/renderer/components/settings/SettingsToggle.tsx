/**
 * SettingsToggle
 *
 * 设置页专用的开关行组件，左侧是标签和描述，右侧是 Switch。
 * 设计为放在 SettingsCard 内部使用。
 */

import * as React from 'react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsToggleProps {
  /** 开关标签（支持字符串或 JSX） */
  label: React.ReactNode
  /** 标签下方的描述说明 */
  description?: string
  /** 当前是否选中 */
  checked: boolean
  /** 状态变化时的回调 */
  onCheckedChange: (checked: boolean) => void
  /** 是否禁用 */
  disabled?: boolean
  /** 额外 className */
  className?: string
  /** 是否在卡片内部，决定 padding */
  inCard?: boolean
}

/**
 * SettingsToggle - 带标签的开关组件
 *
 * @example
 * <SettingsCard>
 *   <SettingsToggle
 *     label="Desktop notifications"
 *     description="Get notified when AI finishes working"
 *     checked={enabled}
 *     onCheckedChange={setEnabled}
 *   />
 * </SettingsCard>
 */
export function SettingsToggle({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
  inCard = true,
}: SettingsToggleProps) {
  const id = React.useId()

  return (
    <div
      data-layout="settings-row"
      className={cn(
        'flex items-center justify-between',
        inCard ? 'px-4 py-3.5' : 'py-3',
        disabled && 'opacity-50',
        className
      )}
    >
      <label htmlFor={id} className="flex-1 min-w-0 cursor-pointer select-none">
        <div className={settingsUI.label}>{label}</div>
        {description && (
          <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</div>
        )}
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        data-layout="settings-control"
        className="ml-4 shrink-0"
      />
    </div>
  )
}
