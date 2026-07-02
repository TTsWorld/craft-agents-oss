/**
 * 实体颜色迁移（Entity Color Migration）
 *
 * 一次性把旧的 Tailwind class 颜色格式迁移成新的 EntityColor 格式。
 * 在配置加载时调用：如果检测到旧格式，就在内存里转换，并标记配置需要回写到磁盘。
 *
 * 旧格式示例："text-accent"、"text-foreground/50"、"#EF4444"
 * 新格式示例："accent"、"foreground/50"、{ light: "#EF4444" }
 */

import type { EntityColor } from './types.ts'

/**
 * 旧 Tailwind class 前缀颜色到新 EntityColor 的映射表。
 * 覆盖了现有配置中已知的所有模式。
 *
 * `Record<string, EntityColor>` 即“字符串键、EntityColor 值”的字典，
 * 相当于 Golang 的 map[string]EntityColor。
 */
const TAILWIND_TO_ENTITY_COLOR: Record<string, EntityColor> = {
  'text-accent': 'accent',
  'text-info': 'info',
  'text-success': 'success',
  'text-error': 'destructive',
  'text-destructive': 'destructive',
  'text-foreground': 'foreground',
  'text-foreground/50': 'foreground/50',
  'text-foreground/60': 'foreground/60',
  'text-foreground/70': 'foreground/70',
  'text-foreground/80': 'foreground/80',
  'text-foreground/90': 'foreground/90',
  'text-warning': 'info', // warning 映射到 info（琥珀色），保持设计系统一致
}

/**
 * 把单个颜色值从旧格式迁移到新的 EntityColor。
 *
 * @param oldColor - 配置里的颜色值（可能是旧格式，也可能已经是新格式）
 * @returns 迁移后的 EntityColor 与是否发生变化；如果无需迁移或值为空，返回 null
 */
export function migrateColorValue(oldColor: unknown): { migrated: EntityColor; changed: boolean } | null {
  // 颜色未设置 —— 无需迁移
  if (oldColor === undefined || oldColor === null) return null

  // 已经是对象（CustomColor）—— 无需迁移
  if (typeof oldColor === 'object') return null

  // 不是字符串也不是对象，无法识别 —— 跳过
  if (typeof oldColor !== 'string') return null

  // 先看是否在已知 Tailwind class 映射表里
  const mapped = TAILWIND_TO_ENTITY_COLOR[oldColor]
  if (mapped) {
    return { migrated: mapped, changed: true }
  }

  // 处理不在映射表中的通用 text-foreground/N 模式
  // 把透明度钳制到 0–100，确保迁移后的值能通过校验
  const fgOpacityMatch = /^text-foreground\/(\d+)$/.exec(oldColor)
  if (fgOpacityMatch) {
    const opacity = Math.min(100, Math.max(0, Number(fgOpacityMatch[1])))
    // `as EntityColor` 是类型断言：TS 知道模板字符串的结果类型是 string，我们手动告诉它这是 EntityColor
    return { migrated: `foreground/${opacity}` as EntityColor, changed: true }
  }

  // 裸 hex 颜色 —— 包装成 CustomColor 对象
  if (/^#[0-9A-Fa-f]{6}$/.test(oldColor)) {
    return { migrated: { light: oldColor }, changed: true }
  }
  if (/^#[0-9A-Fa-f]{8}$/.test(oldColor)) {
    return { migrated: { light: oldColor }, changed: true }
  }

  // 已经是合法系统色字符串（没有 text- 前缀）—— 无需迁移
  return null
}

/**
 * 迁移 statuses 配置对象里的所有颜色值。
 * 会原地修改传入的 config，并返回是否发生过变更。
 */
export function migrateStatusColors(config: { statuses: Array<{ color?: unknown }> }): boolean {
  let changed = false
  for (const status of config.statuses) {
    const result = migrateColorValue(status.color)
    // `result?.changed` 是“可选链”：如果 result 为 null/undefined 就返回 undefined，避免报错
    if (result?.changed) {
      status.color = result.migrated
      changed = true
    }
  }
  return changed
}

/**
 * 迁移 labels 配置对象里的所有颜色值。
 * 会原地修改传入的 config，并返回是否发生过变更。
 */
export function migrateLabelColors(config: { labels: Array<{ color?: unknown; children?: any[] }> }): boolean {
  let changed = false

  // 递归遍历标签树，迁移每个节点的颜色
  function migrateTree(labels: Array<{ color?: unknown; children?: any[] }>): void {
    for (const label of labels) {
      const result = migrateColorValue(label.color)
      if (result?.changed) {
        label.color = result.migrated
        changed = true
      }
      if (label.children && label.children.length > 0) {
        migrateTree(label.children)
      }
    }
  }

  migrateTree(config.labels)
  return changed
}
