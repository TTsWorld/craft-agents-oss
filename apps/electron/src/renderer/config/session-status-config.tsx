/**
 * Session 状态渲染配置：把共享层定义的原始状态（StatusConfig）
 * 转换成 Electron 渲染层可直接使用的 React 元素和颜色。
 */

import * as React from 'react'
import type { CSSProperties } from 'react'
import type { StatusConfig } from '@craft-agent/shared/statuses'
import { isEmoji } from '@craft-agent/shared/utils/icon-constants'
import { resolveEntityColor, getDefaultStatusColor } from '@craft-agent/shared/colors'
import type { EntityColor } from '@craft-agent/shared/colors'
import { StatusIcon } from '@/components/ui/status-icon'
import { iconCache } from '@/lib/icon-cache'

// ============================================================================
// 类型定义
// ============================================================================

// Session 状态 ID：动态状态，任意字符串均可
export type SessionStatusId = string

// Session 状态的基础配置结构
export interface SessionStatusConfig {
  id: string
  label: string
  color?: EntityColor
}

// 渲染层真正使用的 Session 状态对象。
// `extends SessionStatusConfig` 表示继承前者字段，类似 Go 的结构体嵌套/组合。
export interface SessionStatus extends SessionStatusConfig {
  /**
   * 已解析的 CSS 颜色字符串，用于内联样式。
   * 系统色会解析成 CSS 变量，例如 var(--name) 或 color-mix(...)，
   * 能随主题自动切换；自定义颜色则根据 isDark 取对应深浅色值。
   */
  resolvedColor: string

  /** 渲染后的图标节点（React 元素），可直接放进 JSX */
  icon: React.ReactNode

  /**
   * 图标是否能响应 CSS 颜色控制（是否使用 currentColor）。
   * - true：SVG 图标使用 currentColor，可以应用状态颜色
   * - false：Emoji、图片、或颜色写死的 SVG，保持原样/不透明渲染
   */
  iconColorable: boolean

  /** 状态分类：'open' 表示进行中/收件箱，'closed' 表示已关闭/归档 */
  category?: 'open' | 'closed'

  /** 是否为固定状态：true 则不能删除/重命名（如 todo、done） */
  isFixed?: boolean

  /** 是否为默认状态：true 表示可修改但不能删除（如 in-progress） */
  isDefault?: boolean
}

// ============================================================================
// StatusConfig → SessionStatus 转换
// ============================================================================

/**
 * 把后端/共享层的状态配置（StatusConfig）转换成渲染层可用的 SessionStatus。
 *
 * 主要做两件事：
 * 1. 解析颜色：EntityColor 转成可直接写进 style 的 CSS 颜色字符串。
 *    系统色（如 "accent"）会转成 CSS 变量引用，随亮/暗主题自动切换；
 *    自定义颜色根据 isDark 参数选择合适色值。
 * 2. 判断图标是否可着色：
 *    - Emoji 图标本身带颜色，不能再染色
 *    - SVG（使用 currentColor）和兜底图标可以染色
 */
export function statusConfigToSessionStatus(
  config: StatusConfig,
  workspaceId: string,
  isDark: boolean
): SessionStatus {
  // Emoji 自带颜色，不继承 CSS color；SVG 使用 currentColor 或兜底圆点图标可染色
  const iconColorable = !isEmoji(config.icon)

  // 把 EntityColor 解析成供内联样式使用的 CSS 颜色字符串
  const entityColor = config.color ?? getDefaultStatusColor(config.id)
  const resolvedColor = resolveEntityColor(entityColor, isDark)

  return {
    id: config.id,
    label: config.label,
    color: config.color,
    resolvedColor,
    icon: (
      <StatusIcon
        statusId={config.id}
        icon={config.icon}
        workspaceId={workspaceId}
        size="xs"
        chromeless={!iconColorable}
      />
    ),
    iconColorable,
    category: config.category,
    isFixed: config.isFixed,
    isDefault: config.isDefault,
  }
}

/**
 * 批量把 StatusConfig[] 转换成 SessionStatus[]
 */
export function statusConfigsToSessionStatuses(
  configs: StatusConfig[],
  workspaceId: string,
  isDark: boolean
): SessionStatus[] {
  return configs.map(c => statusConfigToSessionStatus(c, workspaceId, isDark))
}

// ============================================================================
// 工具函数（已适配动态状态）
// ============================================================================

/**
 * 根据状态 ID 获取对应图标；找不到则返回默认圆点
 */
export function getStateIcon(
  stateId: string,
  states: SessionStatus[]
): React.ReactNode {
  const state = states.find(s => s.id === stateId)
  return state?.icon ?? <span className="h-3.5 w-3.5">●</span>
}

/**
 * 仅当图标可着色时才返回用于内联样式的样式对象。
 *
 * 可着色图标（SVG/currentColor）会带上解析后的状态颜色；
 * 不可着色图标（emoji/图片）返回 undefined，保持原生颜色和不透明度。
 */
export function getStatusIconStyle(state?: SessionStatus): CSSProperties | undefined {
  return state?.iconColorable ? { color: state.resolvedColor } : undefined
}

/**
 * 先按 ID 查找状态，再决定是否返回图标染色样式
 */
export function getStateIconStyle(
  stateId: string,
  states: SessionStatus[]
): CSSProperties | undefined {
  return getStatusIconStyle(states.find(s => s.id === stateId))
}

/**
 * 获取某个状态已解析好的 CSS 颜色（可直接用于内联样式）
 */
export function getStateColor(
  stateId: string,
  states: SessionStatus[]
): string | undefined {
  return states.find(s => s.id === stateId)?.resolvedColor
}

/**
 * 获取某个状态的显示文本；找不到就回退显示 ID
 */
export function getStateLabel(
  stateId: string,
  states: SessionStatus[]
): string {
  const state = states.find(s => s.id === stateId)
  return state?.label ?? stateId
}

/**
 * 按 ID 获取完整的状态对象
 */
export function getState(
  stateId: string,
  states: SessionStatus[]
): SessionStatus | undefined {
  return states.find(s => s.id === stateId)
}

/**
 * 清空状态图标缓存（状态配置更新后很有用）。
 * 这里只删除统一图标缓存中以 "status:" 为前缀的条目。
 */
export function clearIconCache(): void {
  for (const key of iconCache.keys()) {
    if (key.startsWith('status:')) iconCache.delete(key)
  }
}
