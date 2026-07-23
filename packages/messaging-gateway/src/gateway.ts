/**
 * MessagingGateway —— 各消息平台适配器的编排者。
 *
 * 与 SessionManager 同进程运行。把 adapter、router、renderer 和 binding store
 * 接在一起。每个 workspace 一个实例。
 */

import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { PushTarget } from '@craft-agent/shared/protocol'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  evaluateBindingAccess,
  evaluatePreBindingAccess,
  executeRejection,
} from './access-control'
import { BindingStore } from './binding-store'
import { Router } from './router'
import { Commands, type AccessControlDeps, type PairingCodeConsumer } from './commands'
import { Renderer, type SessionEvent } from './renderer'
import { PendingSendersStore } from './pending-senders'
import { PlanTokenRegistry } from './plan-tokens'
import type {
  PlatformAdapter,
  PlatformType,
  IncomingMessage,
  ButtonPress,
  MessagingConfig,
  MessagingLogger,
  PlatformOwner,
} from './types'

const consoleLogger: MessagingLogger = {
  info: (message, meta) => console.log('[MessagingGateway]', message, meta ?? ''),
  warn: (message, meta) => console.warn('[MessagingGateway]', message, meta ?? ''),
  error: (message, meta) => console.error('[MessagingGateway]', message, meta ?? ''),
  child(context) {
    return {
      info: (message, meta) => console.log('[MessagingGateway]', context, message, meta ?? ''),
      warn: (message, meta) => console.warn('[MessagingGateway]', context, message, meta ?? ''),
      error: (message, meta) => console.error('[MessagingGateway]', context, message, meta ?? ''),
      child: (next) => consoleLogger.child({ ...context, ...next }),
    }
  },
}

export interface GatewayOptions {
  sessionManager: ISessionManager
  workspaceId: string
  /** messaging 存储目录的绝对路径。 */
  storageDir: string
  /** 可选的 legacy 目录，用于 bindings.json 的一次性迁移。 */
  legacyStorageDir?: string
  /** 可选的 consumer，用于解析在别处签发的 /pair 配对码。 */
  pairingConsumer?: PairingCodeConsumer
  /** 任意 binding 变更（bind/unbind）后触发。 */
  onBindingChanged?: () => void
  /**
   * 读取 workspace 的 MessagingConfig。每条消息都调用一次，这样改配置
   *（切换 accessMode、添加 owners）无需重启即可生效。
   * 可选 —— 省略时 gateway 回退到一个宽松的「全部 open」配置
   *（对旧调用方和单测有用）。
   */
  getWorkspaceConfig?: () => MessagingConfig
  /**
   * 当且仅当该平台的 owners 列表当前为空时，把 `candidate` 追加进去。
   * 否则 no-op。被 Commands.handlePair 用于在有人第一次消费配对码时引导 owner 身份。
   */
  seedOwnerOnFirstPair?: (
    platform: PlatformType,
    candidate: PlatformOwner,
  ) => Promise<PlatformOwner[]>
  /**
   * 在 pending-senders 存储发生变更后触发，让 registry 可以向 renderer push 一个事件。
   * 与 `onBindingChanged` 对称。
   */
  onPendingChanged?: () => void
  /** 可选 logger —— 默认用 console。Electron 下传入一个结构化的 host logger。 */
  logger?: MessagingLogger
}

/**
 * 计划批准按钮在聊天里存活期间，按计划维度追踪的元数据。
 * 用于在点击后禁用 inline keyboard。以 plan token 为键。
 */
interface PlanMessageRecord {
  bindingId: string
  platform: PlatformType
  channelId: string
  messageId: string
}

/**
 * 内联 Approve/Deny 按钮在聊天里存活期间，按权限提示维度追踪的元数据。
 * 以 `requestId` 为键。两个作用：
 *
 *  1. 幂等认领 —— `handleButtonPress` 在做任何可见动作之前就移除该条目，
 *     这样第二次点击同一提示时找不到记录，静默 no-op。能止住重复的
 *     「✅ Allowed / ❌ Denied」刷屏。
 *  2. 陈旧提示清理 —— 当 agent 已越过该权限（无论从哪个渠道解决 ——
 *     desktop、MCP 等），`onSessionEvent` 会清扫该条目并清掉 inline keyboard，
 *     这样用户即便点陈旧按钮也产生不了 callback。
 */
interface PermissionMessageRecord {
  bindingId: string
  sessionId: string
  platform: PlatformType
  channelId: string
  messageId: string
  threadId?: number
}

interface PendingCompactAccept {
  token: string
  sessionId: string
  bindingId: string
  platform: PlatformType
  channelId: string
  /** 点击来源的论坛话题 id（Telegram 超级群），可选。 */
  threadId?: number
  messageId: string
  planPath: string
  createdAt: number
}

const COMPACT_ACCEPT_TTL_MS = 10 * 60 * 1000

export class MessagingGateway {
  private readonly sessionManager: ISessionManager
  private readonly workspaceId: string
  private readonly bindingStore: BindingStore
  private readonly pendingStore: PendingSendersStore
  private readonly router: Router
  private readonly commands: Commands
  private readonly renderer: Renderer
  private readonly planTokens: PlanTokenRegistry
  private readonly planMessages = new Map<string, PlanMessageRecord>()
  /** 存活中的权限提示，以 `requestId` 为键。见 PermissionMessageRecord。 */
  private readonly permissionMessages = new Map<string, PermissionMessageRecord>()
  private readonly pendingCompactAccepts = new Map<string, PendingCompactAccept>()
  private readonly adapters = new Map<PlatformType, PlatformAdapter>()
  private readonly log: MessagingLogger
  private started = false
  /**
   * access-control 表面 —— `getWorkspaceConfig` 每次按钮都调用，这样改配置
   * 无需重启即生效，与文本路径对齐。`recentRejectReplies` 是独立于
   * Router/Commands 的冷却映射表，让回调按钮的拒绝限流与文本拒绝限流相互独立
   *（陌生人狂点按钮不会锁掉他在文本渠道的回复，反之亦然）。
   */
  private readonly accessDeps: AccessControlDeps
  private readonly buttonRecentRejectReplies = new Map<string, number>()

  constructor(opts: GatewayOptions) {
    this.sessionManager = opts.sessionManager
    this.workspaceId = opts.workspaceId
    this.log = (opts.logger ?? consoleLogger).child({
      component: 'gateway',
      workspaceId: opts.workspaceId,
    })
    this.bindingStore = new BindingStore(
      opts.storageDir,
      opts.legacyStorageDir,
      this.log.child({ component: 'binding-store' }),
    )
    if (opts.onBindingChanged) {
      this.bindingStore.onChange(opts.onBindingChanged)
    }

    this.pendingStore = new PendingSendersStore(
      opts.storageDir,
      this.log.child({ component: 'pending-senders' }),
    )
    if (opts.onPendingChanged) {
      this.pendingStore.onChange(opts.onPendingChanged)
    }

    this.accessDeps = {
      getWorkspaceConfig:
        opts.getWorkspaceConfig ?? (() => ({ enabled: false, platforms: {} })),
      seedOwnerOnFirstPair:
        opts.seedOwnerOnFirstPair ?? (async () => []),
      pendingStore: this.pendingStore,
    }

    this.commands = new Commands(
      opts.sessionManager,
      this.bindingStore,
      opts.workspaceId,
      opts.pairingConsumer,
      this.log.child({ component: 'commands' }),
      this.accessDeps,
    )
    this.router = new Router(
      opts.sessionManager,
      this.bindingStore,
      this.commands,
      this.log.child({ component: 'router' }),
      {
        getWorkspaceConfig: this.accessDeps.getWorkspaceConfig,
        pendingStore: this.pendingStore,
      },
    )
    this.planTokens = new PlanTokenRegistry()
    this.renderer = new Renderer({
      planTokens: this.planTokens,
      // renderer 把发送该消息的确切 binding 交给我们。
      // 我们不能自己解析 —— `findBySession` 会返回所有 binding，
      // 挑第一个 Telegram binding 会在 session 有多个 binding 时把消息记到错误的聊天。
      recordPlanMessage: (binding, token, messageId) => {
        this.planMessages.set(token, {
          bindingId: binding.id,
          platform: binding.platform,
          channelId: binding.channelId,
          messageId,
        })
      },
      recordPermissionMessage: (binding, requestId, messageId) => {
        this.permissionMessages.set(requestId, {
          bindingId: binding.id,
          sessionId: binding.sessionId,
          platform: binding.platform,
          channelId: binding.channelId,
          messageId,
          ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
        })
      },
    })
  }

  // -------------------------------------------------------------------------
  // adapter 注册
  // -------------------------------------------------------------------------

  registerAdapter(adapter: PlatformAdapter): void {
    const existing = this.adapters.get(adapter.platform)
    if (existing) {
      existing.destroy().catch((err) => {
        this.log.warn('failed to destroy existing adapter during replacement', {
          event: 'adapter_replace_destroy_failed',
          platform: adapter.platform,
          error: err,
        })
      })
    }
    this.adapters.set(adapter.platform, adapter)
    if (this.started) {
      this.wireAdapter(adapter)
    }
  }

  async unregisterAdapter(platform: PlatformType): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (!adapter) return
    this.adapters.delete(platform)
    try {
      await adapter.destroy()
      this.log.info('adapter unregistered', {
        event: 'adapter_unregistered',
        platform,
      })
    } catch (err) {
      this.log.error('failed to destroy adapter', {
        event: 'adapter_destroy_failed',
        platform,
        error: err,
      })
    }
  }

  getAdapter(platform: PlatformType): PlatformAdapter | undefined {
    return this.adapters.get(platform)
  }

  hasConnectedAdapter(platform: PlatformType): boolean {
    return this.adapters.get(platform)?.isConnected() ?? false
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    for (const adapter of this.adapters.values()) {
      this.wireAdapter(adapter)
    }
    this.log.info('gateway started', { event: 'gateway_started' })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.destroy()
        this.log.info('adapter stopped', {
          event: 'adapter_stopped',
          platform,
        })
      } catch (err) {
        this.log.error('failed to stop adapter', {
          event: 'adapter_stop_failed',
          platform,
          error: err,
        })
      }
    }
    this.adapters.clear()
  }

  private wireAdapter(adapter: PlatformAdapter): void {
    adapter.onMessage(async (msg: IncomingMessage) => {
      const isCommand = msg.text.trim().startsWith('/')
      if (isCommand) {
        const handled = await this.commands.handleCommand(adapter, msg)
        if (handled) return
      }
      await this.router.route(adapter, msg)
    })

    adapter.onButtonPress(async (press: ButtonPress) => {
      await this.handleButtonPress(adapter.platform, press)
    })

    this.log.info('adapter registered', {
      event: 'adapter_registered',
      platform: adapter.platform,
      capabilities: adapter.capabilities,
    })
  }

  // -------------------------------------------------------------------------
  // 事件处理（由扇出 EventSink 调用）
  // -------------------------------------------------------------------------

  onSessionEvent(channel: string, _target: PushTarget, ...args: any[]): void {
    if (channel !== RPC_CHANNELS.sessions.EVENT) return

    const event = args[0] as SessionEvent | undefined
    if (!event?.sessionId) return

    // 如果该 session 有一个 pending 的「accept & compact」现在刚好压缩完成，
    // 就立即派发批准。放在扇出之前，避免 renderer 自己的
    // `info:compaction_complete` 路径与之竞争。
    if (
      event.type === 'info' &&
      (event as { statusType?: string }).statusType === 'compaction_complete'
    ) {
      void this.finishPendingCompactAccept(event.sessionId)
    }

    // 丢弃该 session 的陈旧权限提示。agent 在有 pending permission 时会暂停，
    // 所以任何非 permission_request 事件都意味着之前的提示已被解决
    //（通过 desktop、MCP allow-list、remember-window 自动批准等）。
    // 没有这次清扫的话，Telegram 里的 inline keyboard 会一直存活，
    // 用户会继续点陈旧按钮 —— 这正是 #726 可见的症状。
    this.sweepStalePermissions(event)

    const bindings = this.bindingStore.findBySession(event.sessionId)
    if (bindings.length === 0) return

    for (const binding of bindings) {
      const adapter = this.adapters.get(binding.platform)
      if (!adapter || !adapter.isConnected()) {
        this.log.warn('dropping session event — adapter not connected', {
          event: 'adapter_not_connected',
          sessionId: event.sessionId,
          platform: binding.platform,
          eventType: event.type,
        })
        continue
      }
      this.renderer.handle(event, binding, adapter).catch((err) => {
        this.log.error('renderer failed to emit event to chat', {
          event: 'renderer_failed',
          sessionId: event.sessionId,
          bindingId: binding.id,
          platform: binding.platform,
          channelId: binding.channelId,
          error: err,
        })
      })
    }
  }

  /**
   * 把 `permissionMessages` 里 requestId 与事件当前权限请求不同
   *（对非权限事件则是全部）的条目丢弃。每个被丢弃的条目我们还
   * fire-and-forget 一次 `clearButtons`，这样 Telegram 就不会再为
   * 这个陈旧提示投递任何 callback。
   *
   * requestId 相同的 `permission_request` 事件会保留，这样 renderer 重渲染时
   *（罕见，但 renderer 重试时有可能）不会把我们之后还要重建的记录也一起删掉。
   */
  private sweepStalePermissions(event: SessionEvent): void {
    if (this.permissionMessages.size === 0) return

    const eventRequestId =
      event.type === 'permission_request'
        ? ((event.request as { requestId?: string } | undefined)?.requestId ?? null)
        : null

    for (const [requestId, record] of this.permissionMessages) {
      if (record.sessionId !== event.sessionId) continue
      if (requestId === eventRequestId) continue
      this.permissionMessages.delete(requestId)

      const adapter = this.adapters.get(record.platform)
      if (adapter?.clearButtons && adapter.isConnected()) {
        adapter.clearButtons(record.channelId, record.messageId).catch(() => {})
      }
      this.log.info('cleared stale permission prompt after agent moved on', {
        event: 'perm_prompt_cleared_stale',
        requestId,
        sessionId: record.sessionId,
        triggerEventType: event.type,
      })
    }
  }

  // -------------------------------------------------------------------------
  // 按钮处理
  // -------------------------------------------------------------------------

  private async handleButtonPress(platform: PlatformType, press: ButtonPress): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (!adapter) return

    // 点击元数据在所有分支里复用，确保回复发回到按钮被点击的那个话题
    //（Telegram 超级群）。
    const pressOpts = press.threadId !== undefined ? { threadId: press.threadId } : {}

    // access 门控。超级群话题里的内联按钮对聊天里所有成员可见，所以没有这层门控，
    // 任何非 owner 都可以点 `bind:`/`perm:`/`plan:` 绕过文本侧的过滤。
    // 文本路径锁了，但 callback 没锁 —— 这正是 access control 要防止的
    //「看起来锁了其实没锁」的 UX。
    const allowed = await this.gateButtonPress(adapter, press)
    if (!allowed) return

    if (press.buttonId.startsWith('bind:')) {
      const sessionId = press.buttonId.slice('bind:'.length)
      const session = await this.sessionManager.getSession(sessionId)
      if (!session) {
        await adapter.sendText(press.channelId, 'Session not found.', pressOpts)
        return
      }

      this.bindingStore.bind(
        this.workspaceId,
        session.id,
        platform,
        press.channelId,
        undefined,
        undefined,
        press.threadId,
      )

      await adapter.sendText(
        press.channelId,
        `Bound to "${session.name || session.id}"`,
        pressOpts,
      )
      return
    }

    if (press.buttonId.startsWith('perm:')) {
      if (platform === 'whatsapp') {
        this.log.warn('ignored chat-side permission interaction for WhatsApp', {
          event: 'whatsapp_permission_button_ignored',
          channelId: press.channelId,
          buttonId: press.buttonId,
        })
        await adapter.sendText(
          press.channelId,
          '⏸ Permission required. Approve it in the desktop app to continue.',
          pressOpts,
        )
        return
      }

      await this.handlePermissionButton(adapter, press)
      return
    }

    if (press.buttonId.startsWith('plan:')) {
      await this.handlePlanButton(platform, adapter, press)
      return
    }
  }

  /**
   * 处理 `perm:allow:<id>` / `perm:deny:<id>` 的内联点击。
   *
   * 与 `handlePlanButton` 对齐（#726）：在任何可见动作之前，先通过
   * `permissionMessages.delete()` 认领该提示，这样第二次点击会静默 no-op；
   * 清掉 inline keyboard，让 Telegram 连后续 callback 都不再投递；
   * 只有当 `respondToPermission` 报告响应确实送达了一个存活的 agent 时，
   * 才发出面向用户的 `✅ Allowed / ❌ Denied` 确认。
   */
  private async handlePermissionButton(
    adapter: PlatformAdapter,
    press: ButtonPress,
  ): Promise<void> {
    const startedAt = Date.now()
    const pressOpts = press.threadId !== undefined ? { threadId: press.threadId } : {}

    const parts = press.buttonId.split(':')
    const action = parts[1]
    const requestId = parts[2]
    if (!requestId || (action !== 'allow' && action !== 'deny')) return

    // 幂等认领：先把条目移除。并发的第二次点击
    //（或与 onSessionEvent 里陈旧提示清扫的竞争）在这里找不到记录，
    // 静默退出 —— 不会出现重复的「✅ Allowed」消息。
    const record = this.permissionMessages.get(requestId)
    if (!record) {
      this.log.info('perm press dropped: no live prompt for requestId', {
        event: 'perm_press_stale',
        requestId,
        channelId: press.channelId,
        senderId: press.senderId,
      })
      return
    }
    this.permissionMessages.delete(requestId)

    // 在做其他任何事之前先清掉 inline keyboard，让 Telegram 根本不再为
    // 这个提示投递后续 callback。
    if (adapter.clearButtons) {
      await adapter.clearButtons(record.channelId, record.messageId).catch(() => {})
    }

    const allowed = action === 'allow'
    const delivered = this.sessionManager.respondToPermission(
      record.sessionId,
      requestId,
      allowed,
      false,
    )

    this.log.info('perm response routed to session manager', {
      event: 'perm_response_routed',
      requestId,
      sessionId: record.sessionId,
      action,
      delivered,
      elapsedMs: Date.now() - startedAt,
    })

    if (!delivered) {
      // session/agent 已不在，或者提示在我们 `permissionMessages.get()` 到
      // 这里之间已被其他渠道解决。不要发出误导性的「✅ Allowed」——
      // 这边的动作其实没生效。
      return
    }

    await adapter.sendText(press.channelId, allowed ? '✅ Allowed' : '❌ Denied', pressOpts)
  }

  private async handlePlanButton(
    platform: PlatformType,
    adapter: PlatformAdapter,
    press: ButtonPress,
  ): Promise<void> {
    const parts = press.buttonId.split(':')
    const action = parts[1]
    const token = parts[2]
    if (!token || (action !== 'accept' && action !== 'compact')) return

    const pressOpts = press.threadId !== undefined ? { threadId: press.threadId } : {}

    const entry = this.planTokens.resolve(token)
    if (!entry) {
      await adapter.sendText(
        press.channelId,
        '⚠️ This plan has expired. Retry from the desktop app.',
        pressOpts,
      )
      return
    }

    // 禁用按钮，防止用户点两次。失败也非致命。
    const record = this.planMessages.get(token)
    if (record && adapter.clearButtons) {
      await adapter.clearButtons(record.channelId, record.messageId).catch(() => {})
    }

    this.planTokens.revoke(token)
    this.planMessages.delete(token)

    if (action === 'accept') {
      try {
        await this.sessionManager.acceptPlan(entry.sessionId, entry.planPath)
        await adapter.sendText(press.channelId, '✅ Plan accepted. Agent resuming.', pressOpts)
      } catch (err) {
        this.log.error('acceptPlan failed', {
          event: 'plan_accept_failed',
          sessionId: entry.sessionId,
          error: err,
        })
        await adapter.sendText(
          press.channelId,
          '❌ Couldn\'t accept the plan. Check the desktop app.',
          pressOpts,
        )
      }
      return
    }

    // action === 'compact'：持久化「等待压缩」的意图，发送 /compact，
    // 然后让 onSessionEvent → finishPendingCompactAccept 在压缩完成后派发批准。
    const binding = this.bindingStore.findByChannel(platform, press.channelId, press.threadId)
    if (!binding) return

    this.pendingCompactAccepts.set(entry.sessionId, {
      token,
      sessionId: entry.sessionId,
      bindingId: binding.id,
      platform,
      channelId: press.channelId,
      ...(press.threadId !== undefined ? { threadId: press.threadId } : {}),
      messageId: record?.messageId ?? '',
      planPath: entry.planPath,
      createdAt: Date.now(),
    })

    try {
      await this.sessionManager.setPendingPlanExecution(entry.sessionId, entry.planPath)
      await this.sessionManager.sendMessage(entry.sessionId, '/compact')
      await adapter.sendText(
        press.channelId,
        '♻️ Compacting conversation, then executing the plan…',
        pressOpts,
      )
    } catch (err) {
      this.pendingCompactAccepts.delete(entry.sessionId)
      this.log.error('compact dispatch failed', {
        event: 'plan_compact_failed',
        sessionId: entry.sessionId,
        error: err,
      })
      await adapter.sendText(
        press.channelId,
        '❌ Couldn\'t start compaction. Check the desktop app.',
        pressOpts,
      )
    }
  }

  /**
   * 判断一次按钮点击能否继续。`bind:` 仅 workspace owner 可用
   *（与 `/bind` 文本命令一致）；`perm:` 和 `plan:` 受 binding 的 access 策略约束
   *（与 Router.route 在路由时的检查一致）。bot 发件人在任何其他逻辑之前就被静默丢弃。
   *
   * 返回 true 表示放行，false 表示拒绝（调用方必须立即返回）。
   * 拒绝路径会发出友好回复，并通过公共的 `executeRejection` helper
   * 把发送方记入 pending-senders 存储区。
   */
  private async gateButtonPress(
    adapter: PlatformAdapter,
    press: ButtonPress,
  ): Promise<boolean> {
    const senderShape: import('./access-control').RejectableSender = {
      platform: press.platform,
      channelId: press.channelId,
      ...(press.threadId !== undefined ? { threadId: press.threadId } : {}),
      senderId: press.senderId,
      ...(press.senderName ? { senderName: press.senderName } : {}),
      ...(press.senderUsername ? { senderUsername: press.senderUsername } : {}),
    }

    let verdict: import('./access-control').AccessDecision
    let extra: { bindingId?: string; sessionId?: string } = {}

    if (press.buttonId.startsWith('bind:')) {
      // `bind:` 走与 `/bind` 文本命令相同的门控 —— 发出该键盘的运营者
      // 是在提供绑定 session 的特权，但只有 owner 才能领取。
      verdict = evaluatePreBindingAccess({
        msg: this.synthesizeMsgForGate(press),
        workspaceConfig: this.accessDeps.getWorkspaceConfig(),
      })
    } else if (
      press.buttonId.startsWith('perm:') ||
      press.buttonId.startsWith('plan:')
    ) {
      // `perm:`/`plan:` 是 session 级审批；发送方必须对按钮所依附的 binding
      // 拥有路由访问权。
      const binding = this.bindingStore.findByChannel(
        press.platform,
        press.channelId,
        press.threadId,
      )
      if (!binding) {
        // 没有可评估的 binding —— 交给调用方现有的「未绑定」处理
        //（对 perm/plan 而言反正会静默 no-op，因为它们本来就要查 binding）。
        return true
      }
      extra = { bindingId: binding.id, sessionId: binding.sessionId }
      verdict = evaluateBindingAccess({
        msg: this.synthesizeMsgForGate(press),
        workspaceConfig: this.accessDeps.getWorkspaceConfig(),
        binding,
      })
    } else {
      // 未知按钮前缀 —— 交给调用方处理。
      return true
    }

    if (verdict.allow) return true

    await executeRejection(
      adapter,
      senderShape,
      verdict.reason,
      {
        recentRejectReplies: this.buttonRecentRejectReplies,
        pendingStore: this.pendingStore,
      },
      this.log,
      extra,
    )
    return false
  }

  /**
   * 构造 access evaluator 所需的最小 `IncomingMessage` 形状。
   * evaluator 只会读取 `platform`、`senderId`、`senderIsBot` ——
   * 其余字段对按钮点击路径而言都是占位/空。
   */
  private synthesizeMsgForGate(press: ButtonPress): IncomingMessage {
    return {
      platform: press.platform,
      channelId: press.channelId,
      ...(press.threadId !== undefined ? { threadId: press.threadId } : {}),
      messageId: press.messageId,
      senderId: press.senderId,
      ...(press.senderName ? { senderName: press.senderName } : {}),
      ...(press.senderUsername ? { senderUsername: press.senderUsername } : {}),
      ...(press.senderIsBot ? { senderIsBot: true } : {}),
      text: '',
      timestamp: Date.now(),
      raw: press,
    }
  }

  private async finishPendingCompactAccept(sessionId: string): Promise<void> {
    const entry = this.pendingCompactAccepts.get(sessionId)
    if (!entry) return
    this.pendingCompactAccepts.delete(sessionId)

    if (Date.now() - entry.createdAt > COMPACT_ACCEPT_TTL_MS) {
      this.log.warn('dropping stale compact-accept entry', {
        event: 'plan_compact_stale',
        sessionId,
      })
      return
    }

    const adapter = this.adapters.get(entry.platform)
    const opts = entry.threadId !== undefined ? { threadId: entry.threadId } : {}
    try {
      await this.sessionManager.acceptPlan(sessionId, entry.planPath)
      await this.sessionManager.clearPendingPlanExecution(sessionId)
      if (adapter?.isConnected()) {
        await adapter.sendText(entry.channelId, '✅ Plan executing after compaction.', opts)
      }
    } catch (err) {
      this.log.error('post-compaction acceptPlan failed', {
        event: 'plan_post_compact_accept_failed',
        sessionId,
        error: err,
      })
      if (adapter?.isConnected()) {
        await adapter.sendText(
          entry.channelId,
          '❌ Compaction finished but the plan couldn\'t execute. Check the desktop app.',
          opts,
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // 取值器
  // -------------------------------------------------------------------------

  getBindingStore(): BindingStore {
    return this.bindingStore
  }

  getPendingStore(): PendingSendersStore {
    return this.pendingStore
  }

  isStarted(): boolean {
    return this.started
  }
}
