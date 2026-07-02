/**
 * 默认实体颜色
 *
 * 内置实体（例如状态 status）在没有显式指定颜色时会使用这里的默认值。
 * 这些默认值原本放在渲染层的 todo-states.tsx 里，后来被抽到 shared 模块，
 * 这样后端校验和前端渲染可以共用同一套定义。
 */

import type { EntityColor } from './types.ts'

// ============================================================================
// 状态默认值
// ============================================================================

/**
 * 内置状态的默认颜色。
 * 主要使用系统色，并通过透明度后缀表现“弱化”状态。
 *
 * `Record<string, EntityColor>` 表示“键是 string、值是 EntityColor”的字典类型，
 * 和 Golang 的 map[string]EntityColor 类似。
 */
export const DEFAULT_STATUS_COLORS: Record<string, EntityColor> = {
  'backlog': 'foreground/50',       // 弱化 —— 尚未计划
  'todo': 'foreground/50',          // 弱化 —— 待处理
  'in-progress': 'success',         // 绿色 —— 进行中
  'needs-review': 'info',           // 琥珀色 —— 需要关注
  'done': 'accent',                 // 紫色 —— 已完成
  'cancelled': 'foreground/50',     // 弱化 —— 已取消
}

/** 当某个状态没有默认颜色、也不属于已知内置状态时，使用这个兜底颜色 */
export const DEFAULT_STATUS_FALLBACK: EntityColor = 'foreground/50'

/**
 * 根据状态 ID 获取默认颜色。
 * 如果是内置状态则返回对应默认值，否则返回兜底颜色。
 */
export function getDefaultStatusColor(statusId: string): EntityColor {
  // `??` 是“空值合并运算符”：当左边是 null 或 undefined 时取右边，类似 Golang 的 fallback 写法
  return DEFAULT_STATUS_COLORS[statusId] ?? DEFAULT_STATUS_FALLBACK
}
