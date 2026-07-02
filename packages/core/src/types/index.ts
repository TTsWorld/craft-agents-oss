/**
 * 重新导出 @craft-agent/core 的所有类型。
 *
 * 类似于 Golang 中在一个 `types.go` 里汇总各个子包的类型定义，
 * 让外部使用者只需 import 这一个入口。
 */

// ---------- Workspace（工作区）与配置相关类型 ----------
export type {
  WorkspaceInfo,     // 客户端可见的工作区摘要（不含本地路径）
  Workspace,         // 完整工作区，包含 rootPath 等服务器内部字段
  RemoteServerConfig,// 远程 Craft Agent Server 的连接配置
  McpAuthType,       // MCP Server 的认证方式
  AuthType,          // AI  provider 的认证方式
  OAuthCredentials,  // OAuth 流程产生的临时凭证
  StoredConfig,      // 本地持久化的配置（不含加密凭证）
} from './workspace.ts';

// ---------- Session（会话）相关类型 ----------
export type {
  Session,         // 运行时会话
  StoredSession,   // 持久化会话（包含完整消息）
  SessionMetadata, // 会话列表元数据（不含消息内容）
  SessionStatus,   // 工作流状态：todo / in_progress / needs_review / done / cancelled
} from './session.ts';

// ---------- Message（消息）相关类型 ----------
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  Message,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  RecoveryAction,
  ErrorCode,
  TypedError,
  PermissionRequest,
  AgentEvent,
  // 认证相关
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts'; // 生成消息 ID 的工具函数

// ---------- 消息持久化转换器 ----------
// Message 是运行时类型，包含 isStreaming/isPending 等瞬态字段；
// StoredMessage 是落盘类型，需要去掉这些字段。下面两个函数做相互转换。
export { messageToStored, storedToMessage } from './message-mapper.ts';

// ---------- Server（无头服务端）相关类型 ----------
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';

