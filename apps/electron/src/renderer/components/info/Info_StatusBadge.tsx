/**
 * Info_StatusBadge
 *
 * 基于 Info_Badge 封装的权限状态徽章，把 allowed/blocked/requires-permission
 * 三种状态映射为对应的颜色与国际化文案。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Info_Badge, type BadgeColor } from './Info_Badge'

/** 权限状态枚举：允许 / 阻止 / 需要询问 */
type PermissionStatus = 'allowed' | 'blocked' | 'requires-permission'

/** 状态到徽章颜色的映射（permission mode 的可视化） */
const statusColors: Record<PermissionStatus, BadgeColor> = {
  allowed: 'success',
  blocked: 'destructive',
  'requires-permission': 'warning',
}

/** 状态到国际化键（i18n key）的映射，最终由 react-i18next 翻译成界面文案 */
const statusI18nKeys: Record<PermissionStatus, string> = {
  allowed: 'table.statusAllowed',
  blocked: 'table.statusBlocked',
  'requires-permission': 'table.statusAsk',
}

export interface Info_StatusBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** 权限状态 */
  status?: PermissionStatus | null
  /** 覆盖默认显示文本 */
  label?: string
}

export function Info_StatusBadge({
  status,
  label,
  ...props
}: Info_StatusBadgeProps) {
  const { t } = useTranslation()
  const key: PermissionStatus = status ?? 'allowed'
  const displayLabel = label ?? t(statusI18nKeys[key])

  return (
    <Info_Badge {...props} color={statusColors[key]}>
      {displayLabel}
    </Info_Badge>
  )
}
