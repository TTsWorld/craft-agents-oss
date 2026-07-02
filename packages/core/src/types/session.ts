/**
 * 会话（Session）类型定义。
 *
 * Session 是 Craft Agent 里最主要的隔离边界：
 * - 每个 Session 对应一个 CraftAgent 实例
 * - 每个 Session 也对应底层 SDK 的一次 conversation
 *
 * 可以理解为 Golang 项目里的一次"请求上下文"或"聊天上下文"。
 */

import type { StoredMessage, TokenUsage } from './message.ts';

/**
 * 会话工作流状态。
 *
 * Agent 可以根据任务进展更新状态，UI 用不同颜色/图标展示。
 */
export type SessionStatus = 'todo' | 'in_progress' | 'needs_review' | 'done' | 'cancelled';

/**
 * 会话实体。
 */
export interface Session {
  id: string;                    // 唯一 ID，创建时即可确定
  sdkSessionId?: string;         // SDK 返回的会话 ID，首次发消息后拿到
  workspaceId: string;           // 所属工作区
  name?: string;                 // 用户自定义名称
  createdAt: number;
  lastUsedAt: number;

  // 收件箱/归档相关
  isArchived?: boolean;
  isFlagged?: boolean;
  status?: SessionStatus;

  // 已读追踪
  lastReadMessageId?: string;    // 用户最后读到的消息 ID
}

/**
 * 持久化会话（包含完整聊天记录和用量）。
 */
export interface StoredSession extends Session {
  messages: StoredMessage[];
  tokenUsage: TokenUsage;
}

/**
 * 会话列表元数据（加载会话列表时不需要完整消息）。
 */
export interface SessionMetadata {
  id: string;
  workspaceId: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  preview?: string;        // 第一条用户消息的预览
  sdkSessionId?: string;

  // 收件箱/归档相关
  isArchived?: boolean;
  isFlagged?: boolean;
  status?: SessionStatus;
  hidden?: boolean;        // 是否从会话列表隐藏
}
