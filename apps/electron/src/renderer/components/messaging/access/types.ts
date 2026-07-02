/**
 * 渲染层对消息访问控制类型的“别名层”。
 *
 * 真正的类型定义在 `apps/electron/src/shared/types.ts`（主进程与渲染进程共享的 IPC 类型）。
 * 这里做一层薄封装，让 access 目录下的组件不用直接 import 冗长的 `Messaging*Info` 名称。
 * 类似 Go 里的 `type PlatformAccessMode = shared.MessagingPlatformAccessMode` 这种类型别名。
 */

import type {
  MessagingBindingAccessMode,
  MessagingPendingSenderInfo,
  MessagingPlatformAccessMode,
  MessagingPlatformOwnerInfo,
} from '../../../../shared/types'

// 工作空间级访问模式：'open'（任何人都能发）或 'owner-only'（仅允许列表中的用户）
export type PlatformAccessMode = MessagingPlatformAccessMode

// 单条 binding（会话绑定）的访问模式：inherit / allow-list / open
export type BindingAccessMode = MessagingBindingAccessMode

// 平台侧识别的“所有者/已授权用户”
export type PlatformOwner = MessagingPlatformOwnerInfo

// 被拒绝的发送者，等待管理员审批
export type PendingSender = MessagingPendingSenderInfo

export interface BindingAccess {
  mode: BindingAccessMode
  // 仅在 mode === 'allow-list' 时有效，表示允许发送消息的用户 ID 列表
  allowedSenderIds: string[]
}
