/**
 * Claude Agent 模块入口（barrel 文件）
 *
 * 这里把 Claude 相关的对外导出集中在一起，外部可以 `from '@/agent/backend/claude'`
 * 直接拿到 `ClaudeAgent` 主类与事件适配器等。
 *
 * 备注：主要的 `ClaudeAgent` 类位于 ../claude-agent.ts；此 index 仅做统一再导出，
 * 简化调用方的 import 路径（类似 Go 中的 `package` 聚合多个文件）。
 */

// 重新导出主类 ClaudeAgent（Anthropic 官方 SDK 实现的 AgentBackend）
export { ClaudeAgent } from '../../claude-agent.ts';
// 导出事件适配器：把 Claude SDK 的 SDKMessage 转换为内部统一的 AgentEvent
export { ClaudeEventAdapter, buildWindowsSkillsDirError } from './event-adapter.ts';
// 仅导出类型（type-only export）：零运行时开销，仅用于类型标注
export type { ClaudeAdapterCallbacks } from './event-adapter.ts';
