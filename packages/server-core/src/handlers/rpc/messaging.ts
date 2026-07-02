/**
 * Messaging RPC handlers — 消息平台配置与绑定的 UI ↔ Server 通信接口。
 *
 * 负责 Telegram、Lark/Feishu、WhatsApp 等即时通讯平台的配置、配对、绑定与访问控制。
 */

// 本文件属于 Messaging RPC 模块，负责：消息平台（Telegram、Lark/Feishu、WhatsApp 等）的配置、配对、绑定、权限控制。
// Agent 概念：Messaging 让 Agent 能通过即时通讯渠道收发消息；session 可与外部聊天绑定，实现“群聊里@Agent”触发对话。
// TS 提示：类型导入 `type { RpcServer }` 与值导入分离，便于 tree-shaking 和明确依赖关系。

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import type {
  MessagingBindingAccessMode,
  MessagingPendingRejectReason,
  MessagingPlatformAccessMode,
  MessagingPlatformOwnerInfo,
} from '../messaging-registry-interface'

// registerMessagingHandlers：注册消息平台相关 RPC 路由。
export function registerMessagingHandlers(server: RpcServer, deps: HandlerDeps): void {
  const registry = deps.messagingRegistry
  if (!registry) return

  // 获取 workspace 的消息平台配置
  server.handle(RPC_CHANNELS.messaging.GET_CONFIG, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.getConfig(ctx.workspaceId)
  })

  // 更新 workspace 的消息平台配置
  server.handle(RPC_CHANNELS.messaging.UPDATE_CONFIG, async (ctx, config: Record<string, unknown>) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.updateConfig(ctx.workspaceId, config)
    return { success: true }
  })

  // 测试 Telegram bot token 是否有效
  server.handle(RPC_CHANNELS.messaging.TEST_TELEGRAM, async (_ctx, token: string) => {
    return registry.testTelegramToken(token)
  })

  // 保存 Telegram bot token
  server.handle(RPC_CHANNELS.messaging.SAVE_TELEGRAM, async (ctx, token: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.saveTelegramToken(ctx.workspaceId, token)
    return { success: true }
  })

  // 测试 Lark/Feishu 应用凭证
  server.handle(RPC_CHANNELS.messaging.TEST_LARK, async (
    _ctx,
    creds: { appId: string; appSecret: string; domain: 'lark' | 'feishu' },
  ) => {
    return registry.testLarkCredentials(creds)
  })

  // 保存 Lark/Feishu 应用凭证
  server.handle(RPC_CHANNELS.messaging.SAVE_LARK, async (
    ctx,
    creds: { appId: string; appSecret: string; domain: 'lark' | 'feishu' },
  ) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.saveLarkCredentials(ctx.workspaceId, creds)
    return { success: true }
  })

  // 断开某个消息平台连接
  server.handle(RPC_CHANNELS.messaging.DISCONNECT, async (ctx, platform: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.disconnectPlatform(ctx.workspaceId, platform)
    return { success: true }
  })

  // 遗忘某个消息平台配置（清除本地保存的 token/凭证）
  server.handle(RPC_CHANNELS.messaging.FORGET, async (ctx, platform: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.forgetPlatform(ctx.workspaceId, platform)
    return { success: true }
  })

  // 获取当前 workspace 的会话-平台绑定列表
  server.handle(RPC_CHANNELS.messaging.GET_BINDINGS, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.getBindings(ctx.workspaceId)
  })

  // 为某个 session 生成与消息平台的配对码
  server.handle(RPC_CHANNELS.messaging.GENERATE_CODE, async (ctx, sessionId: string, platform: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.generatePairingCode(ctx.workspaceId, sessionId, platform)
  })

  // 解绑某个 session 与消息平台（platform 可选，不传则解绑所有平台）
  server.handle(RPC_CHANNELS.messaging.UNBIND, async (ctx, sessionId: string, platform?: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    registry.unbindSession(ctx.workspaceId, sessionId, platform)
    return { success: true }
  })

  // 解绑某个绑定记录
  server.handle(RPC_CHANNELS.messaging.UNBIND_BINDING, async (ctx, bindingId: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return { success: registry.unbindBinding(ctx.workspaceId, bindingId) }
  })

  // Workspace 与 Telegram forum 超级群配对（Phase A）
  server.handle(RPC_CHANNELS.messaging.GENERATE_SUPERGROUP_CODE, async (ctx, platform: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.generateSupergroupPairingCode(ctx.workspaceId, platform)
  })

  // 获取 workspace 已绑定的超级群
  server.handle(RPC_CHANNELS.messaging.GET_SUPERGROUP, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.getWorkspaceSupergroup(ctx.workspaceId)
  })

  // 解绑 workspace 超级群
  server.handle(RPC_CHANNELS.messaging.UNBIND_SUPERGROUP, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.unbindWorkspaceSupergroup(ctx.workspaceId)
    return { success: true }
  })

  // 启动 WhatsApp 连接流程
  server.handle(RPC_CHANNELS.messaging.WA_START_CONNECT, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.startWhatsAppConnect(ctx.workspaceId)
    return { success: true }
  })

  // 提交 WhatsApp 手机号以继续配对
  server.handle(RPC_CHANNELS.messaging.WA_SUBMIT_PHONE, async (ctx, phoneNumber: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.submitWhatsAppPhone(ctx.workspaceId, phoneNumber)
    return { success: true }
  })

  // -------------------------------------------------------------------------
  // 访问控制（消息平台访问控制）
  // -------------------------------------------------------------------------

  // 获取某个平台的管理员/所有者列表
  server.handle(
    RPC_CHANNELS.messaging.GET_PLATFORM_OWNERS,
    async (ctx, platform: string) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      return registry.getPlatformOwners(ctx.workspaceId, platform)
    },
  )

  // 设置某个平台的管理员/所有者列表
  server.handle(
    RPC_CHANNELS.messaging.SET_PLATFORM_OWNERS,
    async (ctx, platform: string, owners: MessagingPlatformOwnerInfo[]) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      return registry.setPlatformOwners(ctx.workspaceId, platform, owners)
    },
  )

  // 获取某个平台的访问模式（开放/仅管理员/仅绑定等）
  server.handle(
    RPC_CHANNELS.messaging.GET_PLATFORM_ACCESS_MODE,
    async (ctx, platform: string) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      return registry.getPlatformAccessMode(ctx.workspaceId, platform)
    },
  )

  // 设置某个平台的访问模式
  server.handle(
    RPC_CHANNELS.messaging.SET_PLATFORM_ACCESS_MODE,
    async (ctx, platform: string, mode: MessagingPlatformAccessMode) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      registry.setPlatformAccessMode(ctx.workspaceId, platform, mode)
      return { success: true }
    },
  )

  // 获取待审批的发送者列表
  server.handle(
    RPC_CHANNELS.messaging.GET_PENDING_SENDERS,
    async (ctx, platform?: string) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      return registry.getPendingSenders(ctx.workspaceId, platform)
    },
  )

  // 忽略某个待审批发送者
  server.handle(
    RPC_CHANNELS.messaging.DISMISS_PENDING_SENDER,
    async (ctx, platform: string, userId: string) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      return { success: registry.dismissPendingSender(ctx.workspaceId, platform, userId) }
    },
  )

  // 允许某个待审批发送者加入
  server.handle(
    RPC_CHANNELS.messaging.ALLOW_PENDING_SENDER,
    async (
      ctx,
      platform: string,
      userId: string,
      entryKey?: { reason?: MessagingPendingRejectReason; bindingId?: string },
    ) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      return registry.allowPendingSender(ctx.workspaceId, platform, userId, entryKey)
    },
  )

  // 设置某条绑定的访问控制（模式 + 白名单发送者）
  server.handle(
    RPC_CHANNELS.messaging.SET_BINDING_ACCESS,
    async (
      ctx,
      bindingId: string,
      access: { mode: MessagingBindingAccessMode; allowedSenderIds?: string[] },
    ) => {
      if (!ctx.workspaceId) throw new Error('Missing workspaceId')
      registry.setBindingAccess(ctx.workspaceId, bindingId, access)
      return { success: true }
    },
  )
}
