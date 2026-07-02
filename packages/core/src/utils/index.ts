/**
 * core 包工具函数入口。
 *
 * 作用同 Golang 的 `pkg/utils`：集中导出基础工具函数，供上层包使用。
 */

export { debug } from './debug.ts';
export { normalizePath, pathStartsWith, stripPathPrefix } from './paths.ts';
