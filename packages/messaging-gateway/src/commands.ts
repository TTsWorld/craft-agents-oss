/**
 * Commands —— 处理来自未绑定或已绑定 channel 的聊天命令。
 *
 * /new [name]    —— 创建 session + 绑定
 * /bind          —— 列出最近的 session（或按 id / 序号）
 * /pair <code>   —— 完成一个由 session 发起的配对流程
 * /unbind        —— 解除 channel 绑定
 * /help          —— 显示可用命令
 * /status        —— 显示当前 binding
 * /stop          —— 中止当前 agent 运行
 */

import type { ISessionManager } from '@craft-agent/server-core/handlers'
import {
  evaluatePreBindingAccess,
  executeRejection,
  readPlatformAccessMode,
  readPlatformOwners,
  type AccessRejectReason,
} from './access-control'
import type { BindingStore } from './binding-store'
import type { PendingSendersStore } from './pending-senders'
import type {
  IncomingMessage,
  MessagingConfig,
  MessagingLogger,
  PlatformAdapter,
  PlatformOwner,
  PlatformType,
} from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * 消费配对码的结果。`kind` 标记告诉调用方该跑哪个下游流程
 *（绑定一个 session，还是在 workspace 级别注册这个超级群 chat）。
 */
export type PairingConsumeResult =
  | { kind: 'session'; workspaceId: string; sessionId: string }
  | { kind: 'workspace-supergroup'; workspaceId: string }

/**
 * 由 registry 提供。gateway 把这个 consumer 下发给 Commands，
 * 这样 `/pair` 就能消费通过 app UI 签发的配对码。只接受属于
 * gateway 自身 workspace 的配对码。
 */
export interface PairingCodeConsumer {
  /**
   * 返回此发送方在这一分钟内是否仍可尝试一次 `/pair` 消费。
   * 作为防止暴力破解 6 位配对码的纵深防御。在入口处计数，
   * 而不是在校验之后，所以猜错的尝试也会消耗预算。
   */
  canConsume(platform: PlatformType, senderId: string): boolean
  /** 如果配对码有效则返回待配对信息，否则返回 null。 */
  consume(platform: PlatformType, code: string): PairingConsumeResult | null
  /**
   * 注册刚刚完成配对的超级群。在 Commands.handlePair 里、当消费到的配对码
   * kind 为 `workspace-supergroup` 时调用。执行 registry 里那套
   * 持久化 + adapter 重配置的流程。
   */
  bindWorkspaceSupergroup?(args: {
    platform: PlatformType
    chatId: string
    /** 可选的兜底显示名；registry 可以通过 getChat 取一个真实名称。 */
    fallbackTitle?: string
  }): Promise<{ title: string }>
}

/**
 * gateway 提供的权限控制装配。Commands 在每次命令调用时都会读取 workspace
 * 配置（这样改配置无需重启即生效），并用 `seedOwnerOnFirstPair` 在
 * 有人第一次消费配对码时引导出 owner 身份。
 */
export interface AccessControlDeps {
  getWorkspaceConfig: () => MessagingConfig
  /**
   * 当且仅当该平台的 owners 列表当前为空时，把发送方追加进去。
   * 返回更新后的列表（若 seed 未执行则返回现有列表）。从 `/pair` 消费时调用。
   */
  seedOwnerOnFirstPair: (
    platform: PlatformType,
    candidate: PlatformOwner,
  ) => Promise<PlatformOwner[]>
  /** 可选的 pending-senders 存储，用于记录被拒绝的尝试。 */
  pendingStore?: PendingSendersStore
}

/**
 * gateway 允许*任何人*执行的命令，与 owner 身份无关。`/pair`
 * 是引导态例外（第一个消费配对码的发送方成为 owner），
 * `/help` 则是信息性的。
 */
const ALWAYS_ALLOWED_COMMANDS = new Set(['/pair', '/help'])

/**
 * Telegram（以及其他 Bot API 平台）允许用户在共享聊天里把命令定向给
 * 特定 bot：`/pair@MyBot 123456`。不去掉 `@BotName` 后缀的话，cmd token
 * 就匹配不上我们的 switch 分支，输入规范群格式的用户也就没法完成超级群配对。
 *
 * 对非命令文本返回 `{ cmd: '', args: '' }`。会把 cmd 转小写，
 * 这样调用方可以做精确字符串比较。
 */
export function parseCommand(text: string): { cmd: string; args: string } {
  const trimmed = text.trim()
  const m = trimmed.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i)
  if (!m) return { cmd: '', args: '' }
  return { cmd: '/' + m[1]!.toLowerCase(), args: (m[2] ?? '').trim() }
}

export class Commands {
  private readonly log: MessagingLogger
  private readonly access: AccessControlDeps
  private readonly recentRejectReplies = new Map<string, number>()

  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly bindingStore: BindingStore,
    private readonly workspaceId: string,
    private readonly pairingConsumer?: PairingCodeConsumer,
    logger: MessagingLogger = NOOP_LOGGER,
    access: AccessControlDeps = {
      getWorkspaceConfig: () => ({ enabled: false, platforms: {} }),
      seedOwnerOnFirstPair: async () => [],
    },
  ) {
    this.log = logger
    this.access = access
  }

  async handle(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const text = msg.text.trim()
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    // pre-binding 门控：每条入站触发物都要过一遍 access evaluator，
    // 包括非命令的自由文本。没有这层门控，陌生人 DM「hi」就会收到
    // help 消息（泄露命令），还会绕过 pending-senders 流程。
    // 只有 `/pair`（引导）和 `/help`（信息性）跳过门控。
    const cmd = parseCommand(text).cmd
    const skipsGate = cmd && ALWAYS_ALLOWED_COMMANDS.has(cmd)
    if (!skipsGate) {
      const verdict = evaluatePreBindingAccess({
        msg,
        workspaceConfig: this.access.getWorkspaceConfig(),
      })
      if (!verdict.allow) {
        await this.sendRejection(adapter, msg, verdict.reason)
        return
      }
    }

    // 精确命令派发（已解析；支持 `/cmd@BotName`）。规避了旧的
    // `text.startsWith('/new')` bug —— 那样 `/newuser` 也会被派发到 handleNew。
    if (cmd === '/new') {
      await this.handleNew(adapter, msg)
    } else if (cmd === '/bind') {
      await this.handleBind(adapter, msg)
    } else if (cmd === '/pair') {
      await this.handlePair(adapter, msg)
    } else if (cmd === '/unbind') {
      await this.handleUnbind(adapter, msg)
    } else if (cmd === '/help') {
      await this.handleHelp(adapter, msg)
    } else {
      // 发送方通过了 access 门控（owner 或 open workspace），
      // 但在一个没有 binding 的聊天里输入了自由文本。显示 help 提示。
      await adapter.sendText(
        msg.channelId,
        'No session bound to this chat.\n\n' +
        '/new [name] — start a new session\n' +
        '/bind — connect to an existing session\n' +
        '/pair <code> — redeem a pairing code from the app\n' +
        '/help — show all commands',
        replyOpts,
      )
    }
  }

  async handleCommand(adapter: PlatformAdapter, msg: IncomingMessage): Promise<boolean> {
    const text = msg.text.trim()
    if (!text.startsWith('/')) return false

    // 去掉 Telegram 在共享聊天里用于消歧命令的可选 `@BotName` 后缀。
    // 没有这步，`/pair@MyBot 123456` 永远匹配不上下面的 switch 分支。
    const { cmd } = parseCommand(text)
    if (!cmd) return false

    this.log.info('handling chat command', {
      event: 'command_received',
      workspaceId: this.workspaceId,
      platform: adapter.platform,
      channelId: msg.channelId,
      senderId: msg.senderId,
      command: cmd,
    })

    // 针对直接到达的命令（即用户在已绑定的聊天里输入 —— `gateway.wireAdapter`
    // 总是先尝试 `handleCommand` 再走 `router.route`）的 pre-binding 门控。
    // `/pair` 和 `/help` 始终放行。
    if (!ALWAYS_ALLOWED_COMMANDS.has(cmd)) {
      const verdict = evaluatePreBindingAccess({
        msg,
        workspaceConfig: this.access.getWorkspaceConfig(),
      })
      if (!verdict.allow) {
        await this.sendRejection(adapter, msg, verdict.reason)
        return true
      }
    }

    switch (cmd) {
      case '/new':
        await this.handleNew(adapter, msg)
        return true
      case '/bind':
        await this.handleBind(adapter, msg)
        return true
      case '/pair':
        await this.handlePair(adapter, msg)
        return true
      case '/unbind':
        await this.handleUnbind(adapter, msg)
        return true
      case '/help':
        await this.handleHelp(adapter, msg)
        return true
      case '/status':
        await this.handleStatus(adapter, msg)
        return true
      case '/stop':
        await this.handleStop(adapter, msg)
        return true
      default:
        return false
    }
  }

  /**
   * pre-binding 门控的拒绝回复。委托给公共的 `executeRejection`，
   * 这样文本路径和按钮路径产生完全一致的输出。
   */
  private async sendRejection(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    reason: AccessRejectReason,
  ): Promise<void> {
    await executeRejection(
      adapter,
      msg,
      reason,
      {
        recentRejectReplies: this.recentRejectReplies,
        ...(this.access.pendingStore ? { pendingStore: this.access.pendingStore } : {}),
      },
      this.log,
    )
  }

  // -------------------------------------------------------------------------
  // 命令 handler
  // -------------------------------------------------------------------------

  private async handleNew(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const name = parseCommand(msg.text).args || undefined
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    try {
      const session = await this.sessionManager.createSession(this.workspaceId, { name })

      this.bindingStore.bind(
        this.workspaceId,
        session.id,
        adapter.platform,
        msg.channelId,
        msg.senderName,
        undefined,
        msg.threadId,
      )

      const displayName = session.name || session.id
      await adapter.sendText(
        msg.channelId,
        `Created "${displayName}" — you're connected. Just type to start.`,
        replyOpts,
      )
      this.log.info('session created and bound from chat', {
        event: 'session_created_from_chat',
        workspaceId: this.workspaceId,
        sessionId: session.id,
        platform: adapter.platform,
        channelId: msg.channelId,
        threadId: msg.threadId,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      this.log.error('failed to create session from chat', {
        event: 'session_create_failed',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        error: err,
      })
      await adapter.sendText(msg.channelId, `Failed to create session: ${errorMsg}`, replyOpts)
    }
  }

  private async handleBind(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const bindArg = parseCommand(msg.text).args
    const recent = this.getRecentSessions()
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    if (bindArg) {
      const session = await this.resolveBindTarget(bindArg, recent)
      if (!session) {
        await adapter.sendText(msg.channelId, `Session not found: ${bindArg}`, replyOpts)
        return
      }

      this.bindingStore.bind(
        this.workspaceId,
        session.id,
        adapter.platform,
        msg.channelId,
        msg.senderName,
        undefined,
        msg.threadId,
      )

      this.log.info('chat bound to existing session', {
        event: 'chat_bound',
        workspaceId: this.workspaceId,
        sessionId: session.id,
        platform: adapter.platform,
        channelId: msg.channelId,
        threadId: msg.threadId,
        bindArg,
      })

      await adapter.sendText(msg.channelId, `Bound to "${session.name || session.id}"`, replyOpts)
      return
    }

    if (recent.length === 0) {
      await adapter.sendText(
        msg.channelId,
        'No sessions found. Use /new to create one.',
        replyOpts,
      )
      return
    }

    if (adapter.capabilities.inlineButtons) {
      const buttons = recent.slice(0, adapter.capabilities.maxButtons).map((s) => ({
        id: `bind:${s.id}`,
        label: (s.name || s.id.slice(0, 8)).slice(0, 30),
        data: s.id,
      }))

      await adapter.sendButtons(
        msg.channelId,
        'Recent sessions:',
        buttons,
        replyOpts,
      )
      return
    }

    const lines = recent.map((s, i) => {
      const name = s.name || s.id.slice(0, 8)
      return `${i + 1}. ${name} (${s.id.slice(0, 8)})`
    })

    await adapter.sendText(
      msg.channelId,
      'Recent sessions:\n' + lines.join('\n') + '\n\nUse /bind <number> to connect, or /bind <session-id> if you already know it.',
      replyOpts,
    )
  }

  private async handlePair(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    if (!this.pairingConsumer) {
      await adapter.sendText(msg.channelId, 'Pairing is not available in this build.', replyOpts)
      return
    }

    // 在格式校验之前先做限流 —— 否则攻击者可以无限次获得
    //「格式是否合法」的反馈，这几乎和查配对码一样有用。每一次 `/pair` 尝试都计入预算。
    if (!this.pairingConsumer.canConsume(adapter.platform, msg.senderId)) {
      this.log.warn('pairing consume rate limit hit', {
        event: 'pairing_consume_rate_limited',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
      })
      await adapter.sendText(
        msg.channelId,
        '⏳ Too many pairing attempts. Try again in a minute.',
        replyOpts,
      )
      return
    }

    // 用集中式解析器，让 `/pair@MyBot 123456` 与 `/pair 123456` 行为一致 ——
    // Telegram 在群聊里按 bot 后缀路由命令，很多用户会输入规范形式。
    const { args } = parseCommand(msg.text)
    const code = args.replace(/\s+/g, '')

    if (!/^\d{6}$/.test(code)) {
      await adapter.sendText(
        msg.channelId,
        'Usage: /pair <6-digit code>\n\nGenerate a code from the session menu or the Telegram supergroup setup in the Craft Agent app.',
        replyOpts,
      )
      return
    }

    // 消费前的 access 门控。引导规则：当平台还没有 owner 时，任何一次成功的
    // 消费都会把第一个 owner 种子进去（即输入 `/pair` 的那个用户）。
    // 一旦有了 owner，只有现有 owner 才能继续消费配对码 ——
    // 否则窃取或猜中配对码的攻击者就会直接成为 owner。
    const wsConfig = this.access.getWorkspaceConfig()
    const wsMode = readPlatformAccessMode(wsConfig, adapter.platform)
    const owners = readPlatformOwners(wsConfig, adapter.platform)
    if (
      wsMode === 'owner-only' &&
      owners.length > 0 &&
      !owners.some((o) => o.userId === msg.senderId)
    ) {
      this.log.info('pairing redeem blocked: sender is not an owner', {
        event: 'pairing_redeem_not_owner',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        senderId: msg.senderId,
      })
      await adapter.sendText(
        msg.channelId,
        'Only existing bot owners can redeem pairing codes. Ask an owner to add you in the Craft Agent app.',
        replyOpts,
      )
      return
    }

    const entry = this.pairingConsumer.consume(adapter.platform, code)
    if (!entry) {
      await adapter.sendText(msg.channelId, 'Invalid or expired pairing code.', replyOpts)
      return
    }

    // 种子化第一个 owner。当列表已有成员时 seeder 是 no-op，所以无条件地在
    // 每次成功消费时调用是安全的。失败会被记日志但绝不会阻塞配对本身 ——
    // 丢了种子只是意味着运维之后要手动把用户加进去。
    try {
      await this.access.seedOwnerOnFirstPair(adapter.platform, {
        userId: msg.senderId,
        ...(msg.senderName ? { displayName: msg.senderName } : {}),
        ...(msg.senderUsername ? { username: msg.senderUsername } : {}),
        addedAt: Date.now(),
      })
    } catch (err) {
      this.log.warn('seedOwnerOnFirstPair failed (non-fatal)', {
        event: 'pairing_owner_seed_failed',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        senderId: msg.senderId,
        error: err,
      })
    }

    if (entry.kind === 'workspace-supergroup') {
      await this.handleSupergroupPair(adapter, msg, entry, replyOpts)
      return
    }

    // entry.kind === 'session'
    const session = await this.sessionManager.getSession(entry.sessionId)
    if (!session) {
      await adapter.sendText(msg.channelId, 'Session no longer exists.', replyOpts)
      return
    }

    this.bindingStore.bind(
      entry.workspaceId,
      entry.sessionId,
      adapter.platform,
      msg.channelId,
      msg.senderName,
      undefined,
      msg.threadId,
    )

    this.log.info('pairing code redeemed', {
      event: 'pairing_redeemed',
      kind: 'session',
      workspaceId: entry.workspaceId,
      sessionId: entry.sessionId,
      platform: adapter.platform,
      channelId: msg.channelId,
      threadId: msg.threadId,
    })

    const topicHint = msg.threadId !== undefined
      ? ` (topic #${msg.threadId})`
      : ''
    await adapter.sendText(
      msg.channelId,
      `✅ Paired with "${session.name || session.id}"${topicHint}. You can start chatting now.`,
      replyOpts,
    )
  }

  /**
   * Workspace-超级群配对：在一个 Telegram 超级群里输入 `/pair <code>`，
   * 配合一个 workspace-supergroup 类型的配对码。我们在 workspace 级别
   * 注册这个超级群的 chat_id，让适配器开始接收它（除 DM 外）的消息。
   */
  private async handleSupergroupPair(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    entry: { workspaceId: string },
    replyOpts: { threadId?: number },
  ): Promise<void> {
    if (adapter.platform !== 'telegram') {
      await adapter.sendText(
        msg.channelId,
        'Workspace-supergroup pairing is only supported on Telegram.',
        replyOpts,
      )
      return
    }

    if (!this.pairingConsumer?.bindWorkspaceSupergroup) {
      await adapter.sendText(
        msg.channelId,
        'Supergroup pairing is not enabled in this build.',
        replyOpts,
      )
      return
    }

    try {
      const result = await this.pairingConsumer.bindWorkspaceSupergroup({
        platform: adapter.platform,
        chatId: msg.channelId,
        fallbackTitle: msg.senderName,
      })
      this.log.info('pairing code redeemed', {
        event: 'pairing_redeemed',
        kind: 'workspace-supergroup',
        workspaceId: entry.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        title: result.title,
      })
      await adapter.sendText(
        msg.channelId,
        `✅ Supergroup *${result.title}* paired. Sessions can now be bound to topics in this group.`,
        replyOpts,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.log.error('workspace supergroup bind failed', {
        event: 'workspace_supergroup_bind_failed',
        workspaceId: entry.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        error: err,
      })
      await adapter.sendText(
        msg.channelId,
        `❌ Couldn't pair this supergroup: ${message}`,
        replyOpts,
      )
    }
  }

  private async handleUnbind(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const removed = this.bindingStore.unbind(adapter.platform, msg.channelId, msg.threadId)
    if (removed) {
      await adapter.sendText(msg.channelId, 'Disconnected from session.', replyOpts)
    } else {
      await adapter.sendText(msg.channelId, 'No session is bound to this chat.', replyOpts)
    }
  }

  private async handleStatus(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const binding = this.bindingStore.findByChannel(adapter.platform, msg.channelId, msg.threadId)
    if (!binding) {
      await adapter.sendText(msg.channelId, 'No session bound. Use /bind, /new, or /pair.', replyOpts)
      return
    }

    const session = await this.sessionManager.getSession(binding.sessionId)
    const name = session?.name || binding.sessionId.slice(0, 8)
    const mode = binding.config.approvalChannel
    const responseMode = binding.config.responseMode

    await adapter.sendText(
      msg.channelId,
      `Bound to "${name}"\nApproval: ${mode}\nResponse mode: ${responseMode}`,
      replyOpts,
    )
  }

  private async handleStop(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const binding = this.bindingStore.findByChannel(adapter.platform, msg.channelId, msg.threadId)
    if (!binding) {
      await adapter.sendText(msg.channelId, 'No session bound.', replyOpts)
      return
    }

    try {
      await this.sessionManager.cancelProcessing(binding.sessionId)
      await adapter.sendText(msg.channelId, 'Stopped.', replyOpts)
    } catch {
      await adapter.sendText(msg.channelId, 'Nothing to stop.', replyOpts)
    }
  }

  private async handleHelp(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const bindLine = adapter.platform === 'whatsapp'
      ? '/bind — list recent sessions (then use /bind <number>)\n'
      : '/bind — pick from recent sessions\n'
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    await adapter.sendText(
      msg.channelId,
      'Commands:\n' +
      '/new [name] — create + bind new session\n' +
      bindLine +
      '/bind <id> — bind to specific session\n' +
      '/pair <code> — redeem an app-generated pairing code\n' +
      '/unbind — disconnect this chat\n' +
      '/status — show current binding\n' +
      '/stop — abort current agent run\n' +
      '/help — show this message',
      replyOpts,
    )
  }

  private getRecentSessions(): ReturnType<ISessionManager['getSessions']> {
    return this.sessionManager.getSessions(this.workspaceId)
      .filter((s) => !s.isArchived)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .slice(0, 10)
  }

  private async resolveBindTarget(
    bindArg: string,
    recent: ReturnType<ISessionManager['getSessions']>,
  ): Promise<Awaited<ReturnType<ISessionManager['getSession']>> | undefined> {
    if (/^\d+$/.test(bindArg)) {
      const index = Number(bindArg)
      if (index >= 1 && index <= recent.length) {
        return recent[index - 1]
      }
    }
    return this.sessionManager.getSession(bindArg)
  }
}
