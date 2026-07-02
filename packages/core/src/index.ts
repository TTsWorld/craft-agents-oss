/**
 * @craft-agent/core
 *
 * Craft Agent 的【核心类型与工具函数】入口。
 *
 * 可以把这里理解为 Golang 项目里的 `pkg/core` 包：只放最基础的类型定义（struct/interface）
 * 和与业务无关的工具函数，不碰具体实现。
 *
 * 当前这个包只导出：
 * - types/  ：会话、消息、工作区、服务器等核心类型
 * - utils/  ：路径处理、调试等跨平台工具
 *
 * 注意：存储、凭证、Agent 实现、MCP、Prompt 等具体逻辑目前还在 apps/ 或 packages/shared 里，
 * 没有被移到本包，所以本包是“最薄”的一层。
 */

// 把 types/index.ts 里的所有导出再导出一遍，方便外部 `import ... from '@craft-agent/core'`
export * from './types/index.ts';

// 把 utils/index.ts 里的所有导出再导出一遍
export * from './utils/index.ts';
