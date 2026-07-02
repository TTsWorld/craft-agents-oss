/**
 * sessions 模块入口。
 *
 * SessionManager 是会话管理的核心类：
 * - 维护工作区与会话的映射
 * - 加载/保存会话状态
 * - 创建和销毁 CraftAgent 实例
 * - 把 Agent 事件转发给 EventSink（UI/客户端）
 */
export { SessionManager, setSessionPlatform, setSessionRuntimeHooks, sanitizeForTitle, AGENT_FLAGS } from './SessionManager'
export type { SessionCompletionEvent } from './SessionManager'
