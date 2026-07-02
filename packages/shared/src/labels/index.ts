/**
 * Labels 模块
 *
 * 可配置的会话标签（session labels），用于 workspace。
 * 标签是“叠加”的（一个 session 可以有多个），与互斥的 status 不同。
 * 层级结构用嵌套 JSON 树（children 数组）表示。
 *
 * 这个 barrel 文件是浏览器安全的（不含 Node.js 依赖）。
 * 如需文件系统操作，请从 '@craft-agent/shared/labels/storage' 导入。
 */

// 类型定义（TypeScript 的 interface/type，类似 Golang 的接口/类型别名）
export * from './types.ts';

// 树工具（对嵌套标签树做递归操作）
export * from './tree.ts';

// 值工具（解析/格式化 label::value 条目）
export * from './values.ts';

// 会话标签解析（将用户输入与配置好的标签做校验匹配）
export * from './resolve.ts';

// 标签过滤匹配（唯一的列表/AppShell 过滤谓词）
export * from './filter.ts';

// 自动标签：如需正则求值代码，请直接从 '@craft-agent/shared/labels/auto' 导入，
// 以免把后端逻辑打包进渲染器 bundle。
