/**
 * 自动标签子模块入口
 *
 * 导出自动标签求值、值归一化、规则校验等函数。
 * 这些逻辑包含正则求值，属于后端专属，建议从本路径单独导入，
 * 避免被打包进前端 bundle。
 */

export type { AutoLabelMatch } from './types.ts'
export { evaluateAutoLabels, collectAutoLabelRules } from './evaluator.ts'
export { normalizeValue } from './normalize.ts'
export { validateAutoLabelRule } from './validation.ts'
