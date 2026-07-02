/**
 * LabelIcon —— 标签图标组件
 *
 * Label 是给 Session 打标签用的元数据（类似 GitHub 的 label）。
 * 这个组件用实心圆点展示标签颜色；有子标签时会在圆心显示一个小点。
 * 同时提供 LabelValueTypeIcon，用于提示带值类型的标签（number/date/string/link）尚未输入值。
 */

import type { IconSize } from '@craft-agent/shared/icons'
import type { EntityColor } from '@craft-agent/shared/colors'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import { useTheme } from '@/context/ThemeContext'
import { cn } from '@/lib/utils'
import { Hash, CalendarDays, Type, Link } from 'lucide-react'
import type { LabelConfig } from '@craft-agent/shared/labels'

interface LabelIconProps {
  /** Label 配置（对应 @craft-agent/shared/labels 的 LabelConfig） */
  label: {
    id: string
    /** EntityColor：系统颜色字符串或自定义颜色对象 */
    color?: EntityColor
  }
  /** 尺寸变体（默认 'sm'，Label 通常作为行内小元素） */
  size?: IconSize
  /** 为 true 时圆心加小点，表示该标签还有嵌套子标签 */
  hasChildren?: boolean
  /** 额外的 className */
  className?: string
}

/** 各图标尺寸对应的圆点直径（像素） */
const CIRCLE_SIZES: Record<IconSize, number> = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
}

/** Label 图标：渲染一个带颜色的圆点 */
export function LabelIcon({ label, size = 'sm', hasChildren, className }: LabelIconProps) {
  const { isDark } = useTheme()

  // 解析 Label 颜色，用于内联样式
  const resolvedColor = label.color
    ? resolveEntityColor(label.color, isDark)
    : undefined

  // 所有 Label 使用相同直径，保证行内间距一致
  const diameter = CIRCLE_SIZES[size]
  const padding = 1 // 圆点内边距
  const center = diameter / 2
  const outerRadius = center - padding
  const dotRadius = 1 // 内点直径 2px

  const fillColor = resolvedColor || 'currentColor'

  return (
    <svg
      width={diameter}
      height={diameter}
      viewBox={`0 0 ${diameter} ${diameter}`}
      className={cn('shrink-0', className)}
      style={{ opacity: resolvedColor ? 1 : 0.4 }}
    >
      <circle cx={center} cy={center} r={outerRadius} fill={fillColor} />
      {/* 内点表示该 Label 有嵌套子标签（类似单选按钮）。
          颜色用 color-mix 混合 85% 背景色和 15% Label 色。 */}
      {hasChildren && (
        <circle
          cx={center}
          cy={center}
          r={dotRadius}
          style={{
            fill: `color-mix(in srgb, var(--background) 85%, ${fillColor} 15%)`,
          }}
        />
      )}
    </svg>
  )
}

/**
 * LabelValueTypeIcon —— 为带值类型的 Label 显示占位图标。
 *
 * 把 valueType 映射到 Lucide 图标：
 *   - number → Hash
 *   - date   → CalendarDays
 *   - string → Type
 *   - link   → Link
 *
 * 没有 valueType 时返回 null（纯布尔/存在型标签）。
 * 用于 Label 徽章行和 ActiveOptionBadges，提示该标签等待输入值。
 */
const VALUE_TYPE_ICONS = {
  number: Hash,
  date: CalendarDays,
  string: Type,
  link: Link,
} as const

interface LabelValueTypeIconProps {
  /** Label 的 valueType（'number' | 'date' | 'string' | undefined） */
  valueType: LabelConfig['valueType']
  /** 图标尺寸（像素，默认 11） */
  size?: number
  /** 额外的 className */
  className?: string
}

/** Label 值类型占位图标 */
export function LabelValueTypeIcon({ valueType, size = 11, className }: LabelValueTypeIconProps) {
  if (!valueType) return null

  const IconComponent = VALUE_TYPE_ICONS[valueType]
  if (!IconComponent) return null

  return <IconComponent size={size} className={cn('shrink-0 opacity-45', className)} />
}
