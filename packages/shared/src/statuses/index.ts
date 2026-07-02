/**
 * statuses 模块入口
 *
 * 为 workspace 提供可配置的任务状态（session status）。
 * 本文件只做统一导出，把子模块的公开 API 集中到一处。
 */

// 类型定义
export * from './types.ts';

// 存储层操作
export * from './storage.ts';

// CRUD 操作
export * from './crud.ts';

// 校验逻辑
export * from './validation.ts';

// 默认图标
export * from './default-icons.ts';
