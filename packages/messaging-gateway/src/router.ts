/**
 * Router —— 把来自平台 adapter 的入站消息路由到 session。
 *
 * 查找 (platform, channelId) 对应的 ChannelBinding。
 * 找到 → 过 access-control 门控，然后把所有 `IncomingAttachment.localPath`
 * 条目通过 `readFileAttachment()` 解析为 `FileAttachment`，转发给 SessionManager。
 * 找不到 → 委托给 Commands 处理 /bind、/new 等
 *（Commands 会施加自己的 pre-binding access 门控）。
 */

import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { readFileAttachment } from '@craft-agent/shared/utils'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import {
  evaluateBindingAccess,
  executeRejection,
  type AccessRejectReason,
} from './access-control'
import type { BindingStore } from './binding-store'
import type { Commands } from './commands'
import type { PendingSendersStore } from './pending-senders'
import type {
  IncomingMessage,
  MessagingConfig,
  MessagingLogger,
  PlatformAdapter,
} from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

export interface RouterDeps {
  /** 读取 workspace 当前的 MessagingConfig。每条消息都调用，
   *  这样改配置无需重启即生效。 */
  getWorkspaceConfig: () => MessagingConfig
  /** 可选的 pending-senders 存储区；被拒的尝试会记录在这里，
   *  Settings UI 可以一键「Allow」呈现它们。 */
  pendingStore?: PendingSendersStore
}

export class Router {
  private readonly deps: RouterDeps
  private readonly recentRejectReplies = new Map<string, number>()

  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly bindingStore: BindingStore,
    private readonly commands: Commands,
    private readonly log: MessagingLogger = NOOP_LOGGER,
    deps: RouterDeps = { getWorkspaceConfig: () => ({ enabled: false, platforms: {} }) },
  ) {
    this.deps = deps
  }

  async route(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    // 话题（Telegram 超级群论坛话题）参与 binding 查找键，
    // 所以同一超级群里的两个话题即便共享 `chat.id`，也会路由到不同的 session。
    const binding = this.bindingStore.findByChannel(msg.platform, msg.channelId, msg.threadId)

    if (binding) {
      const verdict = evaluateBindingAccess({
        msg,
        workspaceConfig: this.deps.getWorkspaceConfig(),
        binding,
      })
      if (!verdict.allow) {
        await this.handleReject(adapter, msg, verdict.reason, {
          bindingId: binding.id,
          sessionId: binding.sessionId,
        })
        return
      }

      try {
        const fileAttachments = this.resolveAttachments(msg)
        this.log.info('routing inbound chat message to session', {
          event: 'message_routed',
          platform: msg.platform,
          channelId: msg.channelId,
          threadId: msg.threadId,
          sessionId: binding.sessionId,
          bindingId: binding.id,
          attachmentCount: fileAttachments?.length ?? 0,
        })
        await this.sessionManager.sendMessage(
          binding.sessionId,
          msg.text,
          fileAttachments,
          undefined, // storedAttachments（由 session 层处理）
          undefined, // SendMessageOptions
        )
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        this.log.error('failed to route inbound chat message', {
          event: 'message_route_failed',
          platform: msg.platform,
          channelId: msg.channelId,
          threadId: msg.threadId,
          sessionId: binding.sessionId,
          bindingId: binding.id,
          error: err,
        })
        await adapter.sendText(
          msg.channelId,
          `Failed to send message to session: ${errorMsg}`,
          { threadId: msg.threadId },
        )
      }
      return
    }

    this.log.info('routing inbound chat message to command handler', {
      event: 'message_unbound',
      platform: msg.platform,
      channelId: msg.channelId,
      threadId: msg.threadId,
      messageId: msg.messageId,
    })
    await this.commands.handle(adapter, msg)
  }

  /**
   * 已绑定（本文件）与 pre-binding（Commands）门控共用的拒绝路径。
   * 委托给公共的 `executeRejection`，使文本路径与按钮路径行为一致。
   */
  async handleReject(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    reason: AccessRejectReason,
    extra?: { bindingId?: string; sessionId?: string },
  ): Promise<void> {
    await executeRejection(
      adapter,
      msg,
      reason,
      {
        recentRejectReplies: this.recentRejectReplies,
        ...(this.deps.pendingStore ? { pendingStore: this.deps.pendingStore } : {}),
      },
      this.log,
      extra,
    )
  }

  /**
   * 把 adapter 发出的 `IncomingAttachment[]` 转成 session 所需的
   * `FileAttachment[]` 形状。把二进制下载到磁盘的 adapter 会填 `localPath`；
   * 我们用 `readFileAttachment()` 包装它，由后者处理
   * image→base64 / pdf→base64 / text→utf-8 编码。
   *
   * 没有 `localPath`、或文件读不出来的附件会被静默跳过 ——
   * 上游 adapter 在下载失败时已经记过日志/通知过用户，这里再冒泡就是重复了。
   */
  private resolveAttachments(msg: IncomingMessage): FileAttachment[] | undefined {
    if (!msg.attachments?.length) return undefined
    const built: FileAttachment[] = []
    for (const a of msg.attachments) {
      if (!a.localPath) continue
      const att = readFileAttachment(a.localPath) as FileAttachment | null
      if (!att) continue
      if (a.fileName) att.name = a.fileName
      built.push(att)
    }
    return built.length > 0 ? built : undefined
  }
}
