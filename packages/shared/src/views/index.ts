/**
 * Views 模块入口
 *
 * 视图（View）是从 session 状态动态计算出来的筛选条件，底层使用 Filtrex 表达式。
 * 它们不会被持久化到 session 里， purely runtime evaluation（纯运行时计算）。
 */

export type { ViewConfig, CompiledView, ViewEvaluationContext } from './types.ts';
export { compileView, compileAllViews, evaluateViews, buildViewContext } from './evaluator.ts';
export { validateViewExpression, AVAILABLE_FIELDS, AVAILABLE_FUNCTIONS } from './validation.ts';
export { getDefaultViews } from './defaults.ts';
export { VIEW_FUNCTIONS } from './functions.ts';
