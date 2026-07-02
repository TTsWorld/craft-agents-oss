/**
 * Pi Agent 模块入口（barrel 文件）
 *
 * 集中导出 Pi 相关的类型与类。PiAgent 通过子进程（pi-agent-server）以 JSONL
 * 协议与 Pi SDK 通信，承担 OpenAI / Copilot / Bedrock 等 provider 的接入。
 *
 * 备注：主类 PiAgent 位于 ../pi-agent.ts；此 index 仅做统一再导出。
 */

// 导出主类 PiAgent：实现 AgentBackend，内部管理子进程
export { PiAgent } from '../../pi-agent.ts';
// 事件适配器：把 Pi SDK 的事件流转换为内部统一的 AgentEvent
export { PiEventAdapter } from './event-adapter.ts';
// 共享常量：thinking level 映射、工具名归一化
export { PI_TOOL_NAME_MAP, THINKING_TO_PI } from './constants.ts';
