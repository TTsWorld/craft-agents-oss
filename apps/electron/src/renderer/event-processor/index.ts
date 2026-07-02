/**
 * 事件处理器入口模块
 *
 * 集中处理 Agent 事件，替代原先散落在 App.tsx 里的事件处理逻辑。
 * 这里只做导出：把内部模块的函数/类型暴露给外部使用，类似 Go 的 package 入口。
 */

export { processEvent } from './processor'
export { useEventProcessor } from './useEventProcessor'

// 导出类型：type 是 TS 中定义“类型别名/接口”的关键字，类似 Go 的 interface/type 声明
export type {
  SessionState,
  StreamingState,
  AgentEvent,
  ProcessResult,
  Effect,
  TextDeltaEvent,
  TextCompleteEvent,
  ToolStartEvent,
  ToolResultEvent,
  CompleteEvent,
  ErrorEvent,
  PermissionRequestEvent,
  SourcesChangedEvent,
  PlanSubmittedEvent,
  TaskBackgroundedEvent,
  ShellBackgroundedEvent,
  TaskProgressEvent,
} from './types'

// 导出辅助函数：用于消息查找、更新、新增等纯工具函数
export {
  generateMessageId,
  findMessageByTurnId,
  findStreamingMessage,
  findAssistantMessage,
  findToolMessage,
  updateMessageAt,
  appendMessage,
  insertMessageAt,
  createEmptySession,
} from './helpers'
