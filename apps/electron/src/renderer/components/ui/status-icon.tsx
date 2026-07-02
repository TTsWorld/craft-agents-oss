/**
 * 状态图标组件（StatusIcon）。
 * 对 EntityIcon 的薄封装，专门用于状态（status）。
 * - fallbackIcon 固定为 Circle。
 * - 颜色不在这里处理，由父组件传入 Tailwind 颜色类（如 text-success），通过 CSS currentColor 继承到可着色 SVG。
 * 本地状态图标路径为 statuses/icons/{statusId}.{ext}。
 */

import { Circle } from 'lucide-react'
import { EntityIcon } from '@/components/ui/entity-icon'
import { useEntityIcon } from '@/lib/icon-cache'
import type { IconSize } from '@craft-agent/shared/icons'

// 状态图标本地文件名正则：只允许直接文件名，不允许子目录
const LOCAL_STATUS_ICON_FILENAME_PATTERN = /^[^/\\]+\.(svg|png|jpe?g|webp)$/i

interface StatusIconProps {
  /** 状态 ID，用于定位图标文件。 */
  statusId: string
  /** 配置中的图标值，通常是 emoji 字符串。 */
  icon?: string
  /** 工作区 ID，用于加载本地图标。 */
  workspaceId: string
  /** 尺寸（默认 'sm'，状态图标通常较小）。 */
  size?: IconSize
  /** 外层样式类。 */
  className?: string
  /** 为 true 时 emoji 不渲染容器装饰（背景、圆环、圆角）。 */
  chromeless?: boolean
  /** 为 true 时只渲染 SVG/emoji，不套任何容器。 */
  bare?: boolean
}

/** 解析状态图标的来源：判断是本地文件还是 emoji/配置值。 */
export function resolveStatusIconSource(
  statusId: string,
  icon?: string
): { iconPath?: string; iconValue?: string; iconFileName?: string } {
  const trimmedIcon = typeof icon === 'string' ? icon.trim() : undefined

  // 如果配置值是本地图标文件名，则直接按 statuses/icons/{文件名} 加载
  if (trimmedIcon && LOCAL_STATUS_ICON_FILENAME_PATTERN.test(trimmedIcon)) {
    return {
      iconPath: `statuses/icons/${trimmedIcon}`,
    }
  }

  // 否则把配置值当作 emoji/文本图标，并按 {statusId}.ext 在 statuses/icons 目录查找本地文件
  return {
    iconValue: trimmedIcon,
    iconFileName: statusId,
  }
}

/** 状态图标组件。 */
export function StatusIcon({
  statusId,
  icon,
  workspaceId,
  size = 'sm',
  className,
  chromeless,
  bare,
}: StatusIconProps) {
  const { iconPath, iconValue, iconFileName } = resolveStatusIconSource(statusId, icon)
  const resolved = useEntityIcon({
    workspaceId,
    entityType: 'status',
    identifier: statusId,
    iconPath,
    iconDir: 'statuses/icons',
    iconValue,
    // 状态图标文件命名使用 {statusId}.ext，而不是 icon.ext
    iconFileName,
  })

  return (
    <EntityIcon
      icon={resolved}
      size={size}
      fallbackIcon={Circle}
      className={className}
      chromeless={chromeless}
      bare={bare}
    />
  )
}
