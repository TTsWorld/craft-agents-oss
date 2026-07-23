/**
 * access-control.ts — 权限评估器：判断发件人能否路由到某个 binding 或执行 pre-binding 命令的唯一事实来源。
 *
 * 设计为纯函数，这样 Router 和 Commands 可以一致调用，单测也无需启动完整网关即可覆盖权限矩阵。
 * 返回可区分的 verdict（allow/reason），由调用方决定是放行、回复，还是记录为 pending sender。
 */

import type { PendingSendersStore } from './pending-senders'
import type {
  BindingConfig,
  IncomingMessage,
  MessagingConfig,
  MessagingLogger,
  PlatformAccessMode,
  PlatformAdapter,
  PlatformOwner,
  PlatformType,
} from './types'

/**
 * 友好拒绝回复的冷却窗口。非 owner 每秒都 ping 机器人不应该每秒都收到回复——
 * 回复本身会变成 spam，恶意发件人还可能利用它堵塞机器人自己的出站队列。
 */
export const REJECT_REPLY_COOLDOWN_MS = 60 * 60 * 1000

export type AccessDecision =
  | { allow: true }
  | { allow: false; reason: AccessRejectReason }

export type AccessRejectReason =
  /** 发件人是机器人（Telegram `from.is_bot`）。始终静默丢弃。 */
  | 'bot-sender'
  /** Workspace 模式为 `'owner-only'` 且发件人不在 owners 列表中。 */
  | 'not-owner'
  /** Binding 模式为 `'allow-list'` 且发件人不在 `allowedSenderIds` 中。 */
  | 'not-on-binding-allowlist'

export interface PreBindingAccessInput {
  /** 即将由 Commands 处理的入站消息。 */
  msg: IncomingMessage
  /** Workspace 的消息配置（用于 `accessMode` 与 `owners`）。 */
  workspaceConfig: MessagingConfig
}

/**
 * 判断 `msg` 能否执行 pre-binding 命令（`/new`、`/bind` 等），
 * 即在尚无 binding 时对 workspace 进行操作的命令。
 *
 * 规则：
 *  - 机器人发件人一律拒绝（上游会静默丢弃）。
 *  - 平台 `accessMode` 缺失或为 `'open'` 时放行。
 *  - 为 `'owner-only'` 时，仅当发件人在 `owners` 中才放行。
 */
export function evaluatePreBindingAccess(
  input: PreBindingAccessInput,
): AccessDecision {
  const { msg, workspaceConfig } = input
  if (msg.senderIsBot) return { allow: false, reason: 'bot-sender' }

  const mode = readPlatformAccessMode(workspaceConfig, msg.platform)
  if (mode === 'open') return { allow: true }

  const owners = readPlatformOwners(workspaceConfig, msg.platform)
  if (owners.some((o) => o.userId === msg.senderId)) return { allow: true }
  return { allow: false, reason: 'not-owner' }
}

export interface BindingAccessInput {
  msg: IncomingMessage
  workspaceConfig: MessagingConfig
  binding: { config: BindingConfig }
}

/**
 * 判断 `msg` 能否路由到已存在的 binding。
 *
 * 判定顺序：
 *  1. 机器人发件人 → 拒绝。
 *  2. Binding `accessMode === 'open'` → 放行。
 *  3. Binding `accessMode === 'allow-list'` → 仅当发件人在 `allowedSenderIds` 中才放行。
 *  4. Binding `accessMode === 'inherit'` → 交给 workspace 策略：
 *     `'open'` 放行；`'owner-only'` 要求发件人在 `owners` 中。
 *
 * 注意：`'open'` workspace + `'inherit'` binding 是遗留/迁移路径。
 * 它刻意放行流量，避免这段代码上线当天导致现有线上 workspace 静默失效。
 */
export function evaluateBindingAccess(input: BindingAccessInput): AccessDecision {
  const { msg, workspaceConfig, binding } = input
  if (msg.senderIsBot) return { allow: false, reason: 'bot-sender' }

  const mode = binding.config.accessMode
  if (mode === 'open') return { allow: true }

  if (mode === 'allow-list') {
    return binding.config.allowedSenderIds.includes(msg.senderId)
      ? { allow: true }
      : { allow: false, reason: 'not-on-binding-allowlist' }
  }

  // mode === 'inherit'
  const wsMode = readPlatformAccessMode(workspaceConfig, msg.platform)
  if (wsMode === 'open') return { allow: true }
  const owners = readPlatformOwners(workspaceConfig, msg.platform)
  return owners.some((o) => o.userId === msg.senderId)
    ? { allow: true }
    : { allow: false, reason: 'not-owner' }
}

/**
 * 读取 workspace 的平台级访问模式，对早于该字段出现的配置默认返回 `'open'`，保持向后兼容。
 */
export function readPlatformAccessMode(
  config: MessagingConfig,
  platform: PlatformType,
): PlatformAccessMode {
  if (platform !== 'telegram') return 'open'
  return config.platforms.telegram?.accessMode ?? 'open'
}

/** 读取平台的 owners 列表（未配置时为空）。 */
export function readPlatformOwners(
  config: MessagingConfig,
  platform: PlatformType,
): PlatformOwner[] {
  if (platform !== 'telegram') return []
  return config.platforms.telegram?.owners ?? []
}

/**
 * 入站触发物的身份信息。是 `IncomingMessage` / `ButtonPress` 的子集，
 * 恰好是拒绝辅助函数所需的字段——抽出公共形状，避免在按钮调用处出现
 * 「伪造一个 IncomingMessage」的写法。
 */
export interface RejectableSender {
  platform: PlatformType
  channelId: string
  threadId?: number
  senderId: string
  senderName?: string
  senderUsername?: string
}

export interface RejectionExecutionContext {
  /** 按 (platform, senderId) 维度的冷却映射表。会被原地修改。 */
  recentRejectReplies: Map<string, number>
  /** 可选的 pending-senders 存储区，用于记录非机器人发件人的拒绝事件。 */
  pendingStore?: PendingSendersStore
}

/**
 * 公共拒绝路径：记录日志、写入 pending store、在冷却期内发送友好回复。
 * 被 `Router.handleReject`（文本路径）、`Commands.sendRejection`（pre-binding 文本路径）、
 * 以及 `MessagingGateway.handleButtonPress`（回调按钮路径）共用，使三个入口行为一致。
 */
export async function executeRejection(
  adapter: PlatformAdapter,
  sender: RejectableSender,
  reason: AccessRejectReason,
  ctx: RejectionExecutionContext,
  log: MessagingLogger,
  extra: { bindingId?: string; sessionId?: string } = {},
): Promise<void> {
  log.info('access-control rejected stimulus', {
    event: 'access_rejected',
    reason,
    platform: sender.platform,
    channelId: sender.channelId,
    threadId: sender.threadId,
    senderId: sender.senderId,
    senderUsername: sender.senderUsername,
    bindingId: extra.bindingId,
    sessionId: extra.sessionId,
  })

  if (reason !== 'bot-sender') {
    // 将访问判定的 reason 映射为 pending-store 的 reason。
    // store 只关心两种「面向用户」的原因（workspace 级 vs. binding 级）——
    // bot-sender 在到达这里之前已被静默丢弃。
    const pendingReason =
      reason === 'not-on-binding-allowlist' ? 'not-on-binding-allowlist' : 'not-owner'
    ctx.pendingStore?.recordRejection({
      platform: sender.platform,
      senderId: sender.senderId,
      senderName: sender.senderName,
      senderUsername: sender.senderUsername,
      reason: pendingReason,
      ...(extra.bindingId ? { bindingId: extra.bindingId } : {}),
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
      ...(sender.channelId ? { channelId: sender.channelId } : {}),
      ...(sender.threadId !== undefined ? { threadId: sender.threadId } : {}),
    })
  }

  const replyText = buildRejectionReply(reason)
  if (!replyText) return

  const key = `${sender.platform}:${sender.senderId}`
  const last = ctx.recentRejectReplies.get(key) ?? 0
  if (Date.now() - last < REJECT_REPLY_COOLDOWN_MS) return
  ctx.recentRejectReplies.set(key, Date.now())

  try {
    await adapter.sendText(sender.channelId, replyText, {
      ...(sender.threadId !== undefined ? { threadId: sender.threadId } : {}),
    })
  } catch (err) {
    log.warn('failed to send rejection reply (non-fatal)', {
      event: 'reject_reply_failed',
      platform: sender.platform,
      channelId: sender.channelId,
      error: err,
    })
  }
}

/**
 * 为被拒绝的发件人生成友好回复文本。当判定原因为 `bot-sender` 时返回 null
 * （不回复——机器人循环是个隐患）。
 */
export function buildRejectionReply(reason: AccessRejectReason): string | null {
  switch (reason) {
    case 'bot-sender':
      return null
    case 'not-owner':
      return 'This bot is private. Ask the owner to invite you in the Craft Agent app.'
    case 'not-on-binding-allowlist':
      return "You're not on the allow-list for this conversation. Ask the owner to add you."
  }
}
