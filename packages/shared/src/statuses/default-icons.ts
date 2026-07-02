/**
 * 默认状态图标 SVG
 *
 * 内置的 SVG 字符串，作为默认状态图标使用。
 * 当 statuses/icons/ 目录缺少对应图标文件时，会自动创建这些 SVG 文件。
 */

/**
 * 按文件名（不含 .svg 后缀）索引的默认图标 SVG 字符串。
 *
 * Record<string, string> 是 TS 的类型别名，类似 Go 里的 map[string]string，
 * 表示“键和值都是字符串”的对象。
 */
export const DEFAULT_ICON_SVGS: Record<string, string> = {
  /**
   * Backlog - CircleDashed（间隔较大的虚线圆）
   * 空圆，使用稀疏虚线描边，表示“尚未计划”。
   */
  'backlog': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" stroke-dasharray="6 5" />
</svg>`,

  /**
   * Todo - Circle（实心描边的圆）
   * 空圆，使用实线描边，表示“可以开始处理”。
   */
  'todo': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" />
</svg>`,

  /**
   * In Progress - CircleProgress（左半边填充的圆）
   * 半填充圆，表示“进行中”。
   */
  'in-progress': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" />
  <path d="M12 3a9 9 0 0 0 0 18" fill="currentColor" stroke="none" />
</svg>`,

  /**
   * Needs Review - CircleEye（中间带圆点的圆）
   * 圆中带点，表示“需要 review”。
   */
  'needs-review': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" />
  <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
</svg>`,

  /**
   * Done - CircleCheckFilled（填充圆加对勾）
   * 实心圆加白色对勾，表示“已完成”。
   */
  'done': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
  <circle cx="12" cy="12" r="10" />
  <path d="M8 12l3 3 5-5" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
</svg>`,

  /**
   * Cancelled - CircleXFilled（填充圆加叉）
   * 实心圆加白色叉号，表示“已取消”。
   */
  'cancelled': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
  <circle cx="12" cy="12" r="10" />
  <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
</svg>`,
};

/**
 * 根据状态 ID 获取默认图标的 SVG 字符串。
 *
 * @param statusId 状态 ID
 * @returns SVG 字符串；如果找不到则返回 undefined
 */
export function getDefaultIconSvg(statusId: string): string | undefined {
  return DEFAULT_ICON_SVGS[statusId];
}
