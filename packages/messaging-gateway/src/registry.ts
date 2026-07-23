/**
 * MessagingGatewayRegistry —— 持有各 workspace 的 MessagingGateway 实例。
 *
 * 职责：
 *   - 为 server-core 里的 RPC handler 实现 IMessagingGatewayRegistry。
 *   - 作为单个 EventSink 消费者，把 session 事件扇出到正确的 gateway。
 *   - 持有内存中的配对码管理器（跨 workspace 共享；配对码按 workspace 作用域）。
 *   - 持有每个 workspace 的 MessagingConfig（messaging/config.json）。
 *   - 通过 CredentialManager 负责平台 adapter 的生命周期（初始化/替换/销毁）。
 *
 * registry 构造一次、接入 HandlerDeps，然后通过 initializeWorkspace()
 * 为每个启用了 messaging 的 workspace 填充 gateway。
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { PushTarget } from '@craft-agent/shared/protocol'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import type {
  ISessionManager,
  IMessagingGatewayRegistry,
  MessagingBindingInfo,
  MessagingConfigInfo,
} from '@craft-agent/server-core/handlers'

import { MessagingGateway } from './gateway'
import { ConfigStore } from './config-store'
import { PairingCodeManager } from './pairing'
import { TelegramAdapter } from './adapters/telegram/index'
import { WhatsAppAdapter, type WhatsAppEvent } from './adapters/whatsapp/index'
import { LarkAdapter, parseLarkCredentials, type LarkCredentials } from './adapters/lark/index'
import { TopicRegistry } from './topic-registry'
import type { SessionEvent } from './renderer'
import type { EventSinkFn } from './event-fanout'
import type {
  BindingAccessMode,
  ChannelBinding,
  MessagingConfig,
  MessagingLogger,
  MessagingPlatformRuntimeInfo,
  PendingSender,
  PlatformAccessMode,
  PlatformOwner,
  PlatformType,
} from './types'

const consoleLogger: MessagingLogger = {
  info: (message, meta) => console.log('[MessagingRegistry]', message, meta ?? ''),
  warn: (message, meta) => console.warn('[MessagingRegistry]', message, meta ?? ''),
  error: (message, meta) => console.error('[MessagingRegistry]', message, meta ?? ''),
  child(context) {
    return {
      info: (message, meta) => console.log('[MessagingRegistry]', context, message, meta ?? ''),
      warn: (message, meta) => console.warn('[MessagingRegistry]', context, message, meta ?? ''),
      error: (message, meta) => console.error('[MessagingRegistry]', context, message, meta ?? ''),
      child: (next) => consoleLogger.child({ ...context, ...next }),
    }
  },
}

export interface MessagingGatewayRegistryOptions {
  sessionManager: ISessionManager
  credentialManager: CredentialManager
  /** 给定 workspace 的 messaging 存储目录绝对路径。 */
  getMessagingDir: (workspaceId: string) => string
  /** 可选的 legacy messaging 目录（relocation 之前），用于一次性迁移。 */
  getLegacyMessagingDir?: (workspaceId: string) => string | undefined
  /** 向 UI 客户端广播 RPC push 事件。undefined 时为 no-op。 */
  publishEvent?: (channel: string, target: PushTarget, ...args: unknown[]) => void
  /** 可选的 WhatsApp worker 配置 —— 启用 WhatsApp adapter 必填。 */
  whatsapp?: {
    /** worker 入口的绝对路径（来自 @craft-agent/messaging-whatsapp-worker 的打包/解包产物）。 */
    workerEntry: string
    /** Node 二进制覆盖（默认为 process.execPath 配合 ELECTRON_RUN_AS_NODE）。 */
    nodeBin?: string
    /** 配对流程：'qr' 或 'code'。默认为 'code'（基于手机号）。 */
    pairingMode?: 'qr' | 'code'
  }
  /** 可选 logger —— 与 gateway 和 adapter 共享。 */
  logger?: MessagingLogger
}

interface WorkspaceState {
  gateway: MessagingGateway
  configStore: ConfigStore
  topicRegistry: TopicRegistry
  botUsernames: Partial<Record<PlatformType, string>>
  whatsapp: WhatsAppAdapter | null
  whatsappOffEvent?: () => void
  runtime: Record<PlatformType, MessagingPlatformRuntimeInfo>
}

export class MessagingGatewayRegistry implements IMessagingGatewayRegistry {
  private readonly workspaces = new Map<string, WorkspaceState>()
  private readonly pairing = new PairingCodeManager()
  private readonly log: MessagingLogger

  constructor(private readonly opts: MessagingGatewayRegistryOptions) {
    this.log = (opts.logger ?? consoleLogger).child({ component: 'registry' })

    // 在 SessionManager 上挂载 automation→topic 绑定 hook，让
    // executePromptAutomation 能路由话题绑定的 session，而 SessionManager
    // 无需 import 这个包（避免包级别的循环依赖）。
    opts.sessionManager.setAutomationBinder?.(async (input) => {
      const result = await this.bindAutomationSession(input)
      if (!result.ok) {
        this.log.info('automation topic bind skipped', {
          event: 'automation_topic_bind_skipped',
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          topicName: input.topicName,
          reason: result.reason,
          error: result.error,
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // 公共 registry 生命周期（由 app bootstrap 调用）
  // -------------------------------------------------------------------------

  async initializeWorkspace(workspaceId: string): Promise<void> {
    if (this.workspaces.has(workspaceId)) return

    const state = this.bootstrapWorkspace(workspaceId)
    const config = state.configStore.get()
    if (!config.enabled) return

    await state.gateway.start()
    this.log.info('gateway started for workspace', {
      event: 'gateway_started',
      workspaceId,
    })

    if (isPlatformConfigured(config, 'telegram')) {
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
      })
      void this.tryConnectTelegram(workspaceId, state).catch((err) => {
        this.log.error('background Telegram connect failed', {
          event: 'telegram_connect_failed',
          workspaceId,
          error: err,
        })
      })
    }

    if (isPlatformConfigured(config, 'lark')) {
      this.setPlatformRuntime(workspaceId, state, 'lark', {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
      })
      void this.tryConnectLark(workspaceId, state).catch((err) => {
        this.log.error('background Lark connect failed', {
          event: 'lark_connect_failed',
          workspaceId,
          error: err,
        })
      })
    }

    if (isPlatformConfigured(config, 'whatsapp')) {
      if (this.hasWhatsAppAuthState(workspaceId)) {
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'connecting',
          lastError: undefined,
        })
        void this.startWhatsAppAdapter(workspaceId, state, { persistConfig: false, reason: 'restore' }).catch((err) => {
          this.log.error('background WhatsApp restore failed', {
            event: 'whatsapp_restore_failed',
            workspaceId,
            error: err,
          })
          this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: err instanceof Error ? err.message : String(err),
          })
        })
      } else {
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'reconnect_required',
          lastError: 'WhatsApp needs to be linked again.',
        })
      }
    }
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    await state.gateway.stop()
    this.pairing.clearWorkspace(workspaceId)
    this.workspaces.delete(workspaceId)
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.workspaces.values()).map((s) => s.gateway.stop().catch(() => {}))
    await Promise.all(stops)
    this.workspaces.clear()
  }

  get size(): number {
    return this.workspaces.size
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry —— config
  // -------------------------------------------------------------------------

  getConfig(workspaceId: string): MessagingConfigInfo | null {
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    const cfg = state.configStore.get()
    return {
      enabled: cfg.enabled,
      platforms: cfg.platforms as MessagingConfigInfo['platforms'],
      runtime: {
        telegram: cloneRuntime(state.runtime.telegram),
        whatsapp: cloneRuntime(state.runtime.whatsapp),
        lark: cloneRuntime(state.runtime.lark),
      },
    }
  }

  async updateConfig(
    workspaceId: string,
    partial: Partial<MessagingConfigInfo>,
  ): Promise<void> {
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    state.configStore.update({
      enabled: partial.enabled,
      platforms: partial.platforms,
    } as never)

    const cfg = state.configStore.get()
    if (!cfg.enabled) {
      await state.gateway.unregisterAdapter('telegram').catch(() => {})
      await state.gateway.unregisterAdapter('whatsapp').catch(() => {})
      await state.gateway.unregisterAdapter('lark').catch(() => {})
      state.whatsappOffEvent?.()
      state.whatsappOffEvent = undefined
      state.whatsapp = null
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: false,
        connected: false,
        state: 'disconnected',
        identity: undefined,
        lastError: undefined,
      })
      this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
        configured: false,
        connected: false,
        state: 'disconnected',
        identity: undefined,
        lastError: undefined,
      })
      this.setPlatformRuntime(workspaceId, state, 'lark', {
        configured: false,
        connected: false,
        state: 'disconnected',
        identity: undefined,
        lastError: undefined,
      })
      return
    }

    for (const platform of ['telegram', 'whatsapp', 'lark'] as const) {
      const configured = isPlatformConfigured(cfg, platform)
      if (!configured && state.gateway.getAdapter(platform)) {
        await state.gateway.unregisterAdapter(platform).catch(() => {})
      }
      if (!configured && platform === 'whatsapp') {
        state.whatsappOffEvent?.()
        state.whatsappOffEvent = undefined
        state.whatsapp = null
      }
      if (!configured) {
        this.setPlatformRuntime(workspaceId, state, platform, {
          configured: false,
          connected: false,
          state: 'disconnected',
          identity: undefined,
          lastError: undefined,
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry —— bindings
  // -------------------------------------------------------------------------

  getBindings(workspaceId: string): MessagingBindingInfo[] {
    const state = this.workspaces.get(workspaceId)
    if (!state) return []
    return state.gateway.getBindingStore().getAll().map(toBindingInfo)
  }

  unbindSession(workspaceId: string, sessionId: string, platform?: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    const removed = state.gateway
      .getBindingStore()
      .unbindSession(sessionId, platform as PlatformType | undefined)
    if (removed > 0) this.emitBindingChanged(workspaceId)
  }

  unbindBinding(workspaceId: string, bindingId: string): boolean {
    const state = this.workspaces.get(workspaceId)
    if (!state) return false
    const removed = state.gateway.getBindingStore().unbindById(bindingId)
    if (removed) this.emitBindingChanged(workspaceId)
    return removed
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry —— 配对
  // -------------------------------------------------------------------------

  generatePairingCode(
    workspaceId: string,
    sessionId: string,
    platform: string,
  ): { code: string; expiresAt: number; botUsername?: string } {
    if (!isKnownPlatform(platform)) {
      throw new Error(`Unknown messaging platform: ${platform}`)
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    if (!state.gateway.hasConnectedAdapter(platform)) {
      throw new Error(`${capitalize(platform)} is not connected`)
    }
    const gen = this.pairing.generate(workspaceId, sessionId, platform)
    this.log.info('pairing code generated', {
      event: 'pairing_generated',
      workspaceId,
      sessionId,
      platform,
      expiresAt: gen.expiresAt,
    })
    return {
      code: gen.code,
      expiresAt: gen.expiresAt,
      botUsername: state.botUsernames[platform],
    }
  }

  /**
   * 签发一个 workspace-超级群配对码。用户在目标 Telegram 超级群的任意话题里
   * 输入 `/pair <code>`；机器人捕获 `chat.id` 并持久化为 workspace 接受的
   * 超级群，之后 adapter 开始接收它的消息。
   */
  generateSupergroupPairingCode(
    workspaceId: string,
    platform: string,
  ): { code: string; expiresAt: number; botUsername?: string } {
    if (!isKnownPlatform(platform)) {
      throw new Error(`Unknown messaging platform: ${platform}`)
    }
    if (platform !== 'telegram') {
      throw new Error('Workspace-supergroup pairing is only supported on Telegram.')
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    if (!state.gateway.hasConnectedAdapter(platform)) {
      throw new Error(`${capitalize(platform)} is not connected`)
    }
    const gen = this.pairing.generateForSupergroup(workspaceId, platform)
    this.log.info('supergroup pairing code generated', {
      event: 'pairing_generated',
      kind: 'workspace-supergroup',
      workspaceId,
      platform,
      expiresAt: gen.expiresAt,
    })
    return {
      code: gen.code,
      expiresAt: gen.expiresAt,
      botUsername: state.botUsernames[platform],
    }
  }

  /**
   * 在 workspace 级别持久化配对到的超级群，并通知运行中的 adapter 开始接收
   * 它的消息。在用户于群里输入 `/pair <code>` 后，由 gateway 的
   * `pairingConsumer.bindWorkspaceSupergroup` hook 调用，
   * 也可通过 RPC 直接访问，用于未来的程序化流程。
   */
  async bindWorkspaceSupergroup(
    workspaceId: string,
    platform: PlatformType,
    chatId: string,
    fallbackTitle?: string,
  ): Promise<{ title: string }> {
    if (platform !== 'telegram') {
      throw new Error('Workspace-supergroup pairing is only supported on Telegram.')
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined
    if (!adapter) {
      throw new Error('Telegram adapter is not running. Connect the bot first.')
    }

    // 绑定前校验该聊天确实是一个论坛超级群。没有这步，在 DM
    //（或基础群、或没有开启话题的普通超级群）里输入 `/pair` 会在命令层
    //「成功」，但 `createForumTopic` 执行时会在下游崩掉 —— Telegram 返回
    // `400: Bad Request: the chat is not a forum`。
    const info = await adapter.getChatInfo(chatId)
    if (!info) {
      throw new Error(
        'Cannot pair as supergroup: unable to read chat metadata. ' +
          'The bot may have been removed from the chat or lost permission to read it.',
      )
    }
    if (info.type !== 'supergroup') {
      throw new Error(
        `Cannot pair as supergroup: chat type is "${info.type}" — must be a supergroup. ` +
          'DMs and basic groups cannot host topics.',
      )
    }
    if (!info.isForum) {
      throw new Error(
        'Cannot pair as supergroup: the supergroup does not have topics enabled. ' +
          'In Telegram, open the group → Edit → enable "Topics", then try /pair again.',
      )
    }

    const title = info.title || fallbackTitle || `Group ${chatId}`

    this.patchTelegramConfig(
      workspaceId,
      {
        enabled: true,
        supergroup: { chatId, title, capturedAt: Date.now() },
      },
      { ensureMessagingEnabled: true },
    )

    adapter.setAcceptedSupergroupChatId(chatId)
    this.log.info('workspace supergroup bound', {
      event: 'workspace_supergroup_bound',
      workspaceId,
      platform,
      chatId,
      title,
    })
    return { title }
  }

  /**
   * 遗忘已配对的超级群。已存在的话题绑定仍保留在磁盘上（它们只引用 chatId），
   * 但不再匹配入站 update，因为 adapter 会拒绝来自该聊天的消息。
   * 之后重新连接同一个超级群即可恢复路由。
   */
  async unbindWorkspaceSupergroup(workspaceId: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    const cfg = state.configStore.get()
    const tg = cfg.platforms.telegram
    if (!tg?.supergroup) return

    // 去掉 supergroup 字段，但保留 owners / accessMode / enabled。
    // JSON.stringify 会丢掉 `undefined` 值，所以这等效于删除 key。
    this.patchTelegramConfig(workspaceId, { supergroup: undefined })

    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined
    adapter?.setAcceptedSupergroupChatId(undefined)
    this.log.info('workspace supergroup unbound', {
      event: 'workspace_supergroup_unbound',
      workspaceId,
    })
  }

  /** 当前已配对超级群的读访问器（如有）。 */
  getWorkspaceSupergroup(workspaceId: string): { chatId: string; title: string; capturedAt: number } | null {
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    const sg = state.configStore.get().platforms.telegram?.supergroup
    return sg ? { ...sg } : null
  }

  /**
   * 把一个刚拉起的 automation session 绑定到 workspace 已配对超级群里的
   * 一个 Telegram 论坛话题。话题首次使用时创建，之后复用。
   *
   * 尽力而为：返回一个可区分的结果而非抛出异常，这样调用方
   *（SessionManager）可以记日志后继续，不阻塞 session。
   */
  async bindAutomationSession(args: {
    workspaceId: string
    sessionId: string
    topicName: string
  }): Promise<
    | { ok: true; chatId: string; threadId: number; reused: boolean }
    | {
        ok: false
        reason: 'invalid-name' | 'no-supergroup' | 'no-adapter' | 'topic-create-failed'
        error?: string
      }
  > {
    const trimmed = args.topicName?.trim() ?? ''
    if (trimmed.length === 0 || trimmed.length > 128) {
      return { ok: false, reason: 'invalid-name' }
    }

    const state = this.workspaces.get(args.workspaceId) ?? this.bootstrapWorkspace(args.workspaceId)
    const supergroup = state.configStore.get().platforms.telegram?.supergroup
    if (!supergroup?.chatId) return { ok: false, reason: 'no-supergroup' }

    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined
    if (!adapter) return { ok: false, reason: 'no-adapter' }

    const beforeCacheHit = state.topicRegistry.get(trimmed)

    try {
      const entry = await state.topicRegistry.findOrCreate({
        topicName: trimmed,
        chatId: supergroup.chatId,
        createTopic: (name) => adapter.createForumTopic(supergroup.chatId, name),
      })

      state.gateway.getBindingStore().bind(
        args.workspaceId,
        args.sessionId,
        'telegram',
        entry.chatId,
        trimmed,
        undefined,
        entry.threadId,
      )
      this.emitBindingChanged(args.workspaceId)

      return {
        ok: true,
        chatId: entry.chatId,
        threadId: entry.threadId,
        reused: Boolean(beforeCacheHit),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn('automation topic bind failed', {
        event: 'automation_topic_bind_failed',
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        topicName: trimmed,
        error: message,
      })
      return { ok: false, reason: 'topic-create-failed', error: message }
    }
  }

  /**
   * 丢弃一个缓存的话题条目。不会删除 Telegram 里的那个话题
   *（机器人无从得知用户是否想要保留历史）。适用于某个 automation 被重命名/移除、
   * 用户希望下次用同名话题时新建一个，而不是复用缓存条目的场景。
   */
  async removeAutomationTopic(workspaceId: string, topicName: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    await state.topicRegistry.remove(topicName.trim())
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry —— 平台生命周期
  // -------------------------------------------------------------------------

  async testTelegramToken(
    token: string,
  ): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }> {
    if (!token || token.trim().length === 0) {
      return { success: false, error: 'Token is empty' }
    }
    try {
      const info = await fetchTelegramBotInfo(token.trim())
      if (!info.ok) {
        return { success: false, error: info.description ?? 'Invalid token' }
      }
      return {
        success: true,
        botName: info.result.first_name ?? info.result.username ?? 'bot',
        botUsername: info.result.username,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
      }
    }
  }

  async saveTelegramToken(workspaceId: string, token: string): Promise<void> {
    const trimmed = token.trim()
    if (!trimmed) throw new Error('Token is empty')

    const test = await this.testTelegramToken(trimmed)
    if (!test.success) throw new Error(test.error ?? 'Invalid token')

    await this.opts.credentialManager.set(
      {
        type: 'messaging_bearer',
        workspaceId,
        name: 'telegram',
      },
      { value: trimmed },
    )

    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    // 关键：绝不能用 `{ enabled: true }` 整体替换 platforms.telegram
    // —— 那会抹掉 owners / accessMode / supergroup。只 patch `enabled` 标志，
    // 其余字段保持不动。
    this.patchTelegramConfig(workspaceId, { enabled: true }, { ensureMessagingEnabled: true })

    this.setPlatformRuntime(workspaceId, state, 'telegram', {
      configured: true,
      connected: false,
      state: 'connecting',
      lastError: undefined,
    })

    await this.tryConnectTelegram(workspaceId, state)
    await state.gateway.start()
  }

  /**
   * 校验一对 Lark/飞书 App ID + App Secret，把它们换成 tenant access token。
   * 开放平台在凭据错误时会返回结构化的 error code，我们把它转给用户 ——
   * 省去在「Invalid token」猜测之间来回兜圈子的困惑。
   */
  async testLarkCredentials(
    creds: LarkCredentials,
  ): Promise<{ success: boolean; botName?: string; error?: string }> {
    if (!creds.appId || !creds.appSecret) {
      return { success: false, error: 'App ID or App Secret is empty' }
    }
    try {
      const url =
        creds.domain === 'feishu'
          ? 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
          : 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal'
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
      })
      const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string }
      if (body.code !== 0 || !body.tenant_access_token) {
        return { success: false, error: body.msg ?? 'Invalid credentials' }
      }
      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
      }
    }
  }

  async saveLarkCredentials(workspaceId: string, creds: LarkCredentials): Promise<void> {
    if (!creds.appId || !creds.appSecret) throw new Error('App ID or App Secret is empty')
    if (creds.domain !== 'lark' && creds.domain !== 'feishu') {
      throw new Error('Domain must be "lark" or "feishu"')
    }

    const test = await this.testLarkCredentials(creds)
    if (!test.success) throw new Error(test.error ?? 'Invalid Lark credentials')

    await this.opts.credentialManager.set(
      {
        type: 'messaging_bearer',
        workspaceId,
        name: 'lark',
      },
      { value: JSON.stringify(creds) },
    )

    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    state.configStore.update({
      enabled: true,
      platforms: { lark: { enabled: true, domain: creds.domain } },
    })

    this.setPlatformRuntime(workspaceId, state, 'lark', {
      configured: true,
      connected: false,
      state: 'connecting',
      lastError: undefined,
    })

    await this.tryConnectLark(workspaceId, state)
    await state.gateway.start()
  }

  async disconnectPlatform(workspaceId: string, platform: string): Promise<void> {
    if (!isKnownPlatform(platform)) return
    const state = this.workspaces.get(workspaceId)
    if (!state) return

    if (platform === 'whatsapp') {
      state.whatsappOffEvent?.()
      state.whatsappOffEvent = undefined
      if (state.whatsapp) {
        await state.whatsapp.destroy().catch(() => {})
        state.whatsapp = null
      }
    }

    await state.gateway.unregisterAdapter(platform).catch(() => {})
    state.botUsernames[platform] = undefined
    this.pairing.clearWorkspace(workspaceId)

    // 保留各平台字段（telegram 的 owners / accessMode / supergroup，
    // whatsapp 的 selfChatMode，lark 的 domain），这样重连时不会让运营者
    // 意外看到「重置为 public」。要彻底清空请用 `forgetPlatform`。
    const currentConfig = state.configStore.get()
    const currentPlatformConfig = currentConfig.platforms[platform] ?? { enabled: true }
    const nextPlatforms = {
      ...currentConfig.platforms,
      [platform]: { ...currentPlatformConfig, enabled: false },
    }
    const anyPlatformEnabled = Object.values(nextPlatforms).some((entry) => entry?.enabled)
    state.configStore.update({
      enabled: anyPlatformEnabled,
      platforms: nextPlatforms,
    })

    if (platform !== 'whatsapp') {
      await this.opts.credentialManager
        .delete({ type: 'messaging_bearer', workspaceId, name: platform })
        .catch(() => {})
    }

    this.setPlatformRuntime(workspaceId, state, platform, {
      configured: false,
      connected: false,
      state: 'disconnected',
      identity: undefined,
      lastError: undefined,
    })
  }

  async forgetPlatform(workspaceId: string, platform: string): Promise<void> {
    if (!isKnownPlatform(platform)) return
    await this.disconnectPlatform(workspaceId, platform)
    if (platform === 'whatsapp') {
      const authDir = this.getWhatsAppAuthStateDir(workspaceId)
      try {
        rmSync(authDir, { recursive: true, force: true })
        this.log.info('forgot WhatsApp auth state', {
          event: 'whatsapp_auth_forgotten',
          workspaceId,
          authDir,
        })
      } catch (err) {
        this.log.error('failed to forget WhatsApp auth state', {
          event: 'whatsapp_auth_forget_failed',
          workspaceId,
          authDir,
          error: err,
        })
        throw err
      }
    }
  }

  // -------------------------------------------------------------------------
  // WhatsApp —— 子进程生命周期
  // -------------------------------------------------------------------------

  async startWhatsAppConnect(workspaceId: string): Promise<void> {
    const waConfig = this.opts.whatsapp
    if (!waConfig) {
      throw new Error('WhatsApp support is not configured on this server')
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
      configured: true,
      connected: false,
      state: 'connecting',
      lastError: undefined,
    })
    await this.startWhatsAppAdapter(workspaceId, state, { persistConfig: true, reason: 'user_connect' })
  }

  async submitWhatsAppPhone(workspaceId: string, phoneNumber: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state?.whatsapp) {
      throw new Error('WhatsApp not started — call startWhatsAppConnect first')
    }
    const cleaned = phoneNumber.replace(/[^\d]/g, '')
    if (cleaned.length < 8) throw new Error('Phone number looks too short')
    await state.whatsapp.requestPairingCode(cleaned)
  }

  private async startWhatsAppAdapter(
    workspaceId: string,
    state: WorkspaceState,
    options: { persistConfig: boolean; reason: 'restore' | 'user_connect' },
  ): Promise<void> {
    const waConfig = this.opts.whatsapp
    if (!waConfig) {
      throw new Error('WhatsApp support is not configured on this server')
    }

    state.whatsappOffEvent?.()
    state.whatsappOffEvent = undefined
    if (state.whatsapp) {
      await state.whatsapp.destroy().catch(() => {})
      state.whatsapp = null
    }

    const adapter = new WhatsAppAdapter()
    state.whatsapp = adapter
    state.whatsappOffEvent = adapter.onEvent((ev) => this.onWhatsAppEvent(workspaceId, ev))

    // selfChatMode：默认开启。持久化到 workspace config，这样重启后仍生效，
    // 以后用户想要纯联系人路由时也可切换。
    const persistedCfg = state.configStore.get()
    const selfChatMode = persistedCfg.platforms.whatsapp?.selfChatMode ?? true

    await adapter.initialize({
      workerEntry: waConfig.workerEntry,
      nodeBin: waConfig.nodeBin,
      authStateDir: this.getWhatsAppAuthStateDir(workspaceId),
      pairingMode: waConfig.pairingMode ?? 'code',
      selfChatMode,
      logger: this.log.child({
        component: 'whatsapp-adapter',
        workspaceId,
        platform: 'whatsapp',
      }),
    })

    state.gateway.registerAdapter(adapter)
    if (options.persistConfig) {
      state.configStore.update({
        enabled: true,
        platforms: { whatsapp: { enabled: true, selfChatMode } },
      })
    }
    await state.gateway.start()
    this.log.info('WhatsApp adapter started', {
      event: 'whatsapp_adapter_started',
      workspaceId,
      reason: options.reason,
    })
  }

  private onWhatsAppEvent(workspaceId: string, event: WhatsAppEvent): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return

    this.opts.publishEvent?.(
      RPC_CHANNELS.messaging.WA_UI_EVENT,
      { to: 'workspace', workspaceId },
      { workspaceId, event },
    )

    switch (event.type) {
      case 'qr':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'reconnect_required',
          lastError: 'QR scan required',
        })
        return
      case 'connected':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: true,
          state: 'connected',
          identity: event.name ?? event.jid,
          lastError: undefined,
        })
        return
      case 'disconnected':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: event.loggedOut ? 'reconnect_required' : 'disconnected',
          lastError: event.reason,
          identity: undefined,
        })
        return
      case 'unavailable':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'error',
          lastError: event.message,
          identity: undefined,
        })
        return
      case 'error':
        if (!state.runtime.whatsapp.connected) {
          this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: event.message,
          })
        }
        return
      case 'pairing_code':
        return
    }
  }

  // -------------------------------------------------------------------------
  // EventSink 兼容的回调
  // -------------------------------------------------------------------------

  onSessionEvent: EventSinkFn = (channel: string, target: PushTarget, ...args: unknown[]) => {
    if (channel !== RPC_CHANNELS.sessions.EVENT) return

    const event = args[0] as SessionEvent | undefined
    if (!event?.sessionId) return

    const workspaceId =
      'workspaceId' in target ? (target as { workspaceId: string }).workspaceId : undefined
    if (!workspaceId) {
      for (const state of this.workspaces.values()) {
        state.gateway.onSessionEvent(channel, target, ...args)
      }
      return
    }

    const state = this.workspaces.get(workspaceId)
    if (state) state.gateway.onSessionEvent(channel, target, ...args)
  }

  // -------------------------------------------------------------------------
  // 内部辅助函数
  // -------------------------------------------------------------------------

  private bootstrapWorkspace(workspaceId: string): WorkspaceState {
    const existing = this.workspaces.get(workspaceId)
    if (existing) return existing

    const storageDir = this.opts.getMessagingDir(workspaceId)
    const legacyStorageDir = this.opts.getLegacyMessagingDir?.(workspaceId)
    const baseLog = this.log.child({ workspaceId })
    const configStore = new ConfigStore(
      storageDir,
      legacyStorageDir,
      baseLog.child({ component: 'config-store' }),
    )
    const cfg = configStore.get()
    const gateway = new MessagingGateway({
      sessionManager: this.opts.sessionManager,
      workspaceId,
      storageDir,
      legacyStorageDir,
      logger: baseLog,
      pairingConsumer: {
        canConsume: (platform, senderId) =>
          this.pairing.canConsume(workspaceId, platform, senderId),
        consume: (platform, code) => {
          const entry = this.pairing.consume(workspaceId, platform, code)
          if (!entry) return null
          if (entry.kind === 'workspace-supergroup') {
            return { kind: 'workspace-supergroup', workspaceId: entry.workspaceId }
          }
          // entry.kind === 'session'
          if (!entry.sessionId) return null
          return { kind: 'session', workspaceId: entry.workspaceId, sessionId: entry.sessionId }
        },
        bindWorkspaceSupergroup: async ({ platform, chatId, fallbackTitle }) => {
          if (!isKnownPlatform(platform)) {
            throw new Error(`Unknown platform for supergroup pairing: ${platform}`)
          }
          return this.bindWorkspaceSupergroup(workspaceId, platform, chatId, fallbackTitle)
        },
      },
      // 读取实时 config，让 accessMode/owner 切换立即生效。
      getWorkspaceConfig: () => configStore.get(),
      seedOwnerOnFirstPair: async (platform, candidate) =>
        this.seedFirstOwner(workspaceId, platform, candidate),
      onBindingChanged: () => this.emitBindingChanged(workspaceId),
      onPendingChanged: () => this.emitPendingChanged(workspaceId),
    })

    const topicRegistry = new TopicRegistry(
      storageDir,
      baseLog.child({ component: 'topic-registry' }),
    )

    const state: WorkspaceState = {
      gateway,
      configStore,
      topicRegistry,
      botUsernames: {},
      whatsapp: null,
      runtime: {
        telegram: createRuntime('telegram', isPlatformConfigured(cfg, 'telegram')),
        whatsapp: createRuntime('whatsapp', isPlatformConfigured(cfg, 'whatsapp')),
        lark: createRuntime('lark', isPlatformConfigured(cfg, 'lark')),
      },
    }
    this.workspaces.set(workspaceId, state)
    return state
  }

  private async tryConnectLark(workspaceId: string, state: WorkspaceState): Promise<void> {
    const cred = await this.opts.credentialManager
      .get({ type: 'messaging_bearer', workspaceId, name: 'lark' })
      .catch(() => null)

    if (!cred?.value) {
      this.setPlatformRuntime(workspaceId, state, 'lark', {
        configured: true,
        connected: false,
        state: 'error',
        lastError: 'Lark credentials are missing.',
      })
      return
    }

    let creds: LarkCredentials
    try {
      creds = parseLarkCredentials(cred.value)
    } catch (err) {
      this.setPlatformRuntime(workspaceId, state, 'lark', {
        configured: true,
        connected: false,
        state: 'error',
        lastError: err instanceof Error ? err.message : 'Lark credentials are malformed',
      })
      return
    }

    await state.gateway.unregisterAdapter('lark').catch((err) => {
      this.log.warn('unregisterAdapter(lark) failed (non-fatal)', {
        event: 'lark_unregister_failed',
        workspaceId,
        error: err,
      })
    })

    try {
      const adapter = new LarkAdapter()
      await adapter.initialize({
        token: cred.value,
        logger: this.log.child({
          component: 'lark-adapter',
          workspaceId,
          platform: 'lark',
        }),
      })

      try {
        const info = await adapter.getBotInfo()
        state.botUsernames.lark = info?.name
      } catch {
        // 非致命
      }

      state.gateway.registerAdapter(adapter)
      this.setPlatformRuntime(workspaceId, state, 'lark', {
        configured: true,
        connected: true,
        state: 'connected',
        identity: state.botUsernames.lark ?? creds.domain,
        lastError: undefined,
      })
    } catch (err) {
      this.log.error('failed to connect Lark', {
        event: 'lark_connect_failed',
        workspaceId,
        error: err,
      })
      this.setPlatformRuntime(workspaceId, state, 'lark', {
        configured: true,
        connected: false,
        state: 'error',
        lastError: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private async tryConnectTelegram(workspaceId: string, state: WorkspaceState): Promise<void> {
    const cred = await this.opts.credentialManager
      .get({ type: 'messaging_bearer', workspaceId, name: 'telegram' })
      .catch(() => null)

    if (!cred?.value) {
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: false,
        state: 'error',
        lastError: 'Telegram token is missing.',
      })
      return
    }

    await state.gateway.unregisterAdapter('telegram').catch((err) => {
      this.log.warn('unregisterAdapter(telegram) failed (non-fatal)', {
        event: 'telegram_unregister_failed',
        workspaceId,
        error: err,
      })
    })

    try {
      const adapter = new TelegramAdapter()
      const supergroupChatId = state.configStore.get().platforms.telegram?.supergroup?.chatId
      await adapter.initialize({
        token: cred.value,
        ...(supergroupChatId ? { acceptedSupergroupChatId: supergroupChatId } : {}),
        logger: this.log.child({
          component: 'telegram-adapter',
          workspaceId,
          platform: 'telegram',
        }),
      })

      try {
        const info = await adapter.getBotInfo()
        state.botUsernames.telegram = info?.username
      } catch {
        // 非致命
      }

      state.gateway.registerAdapter(adapter)
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: true,
        state: 'connected',
        identity: state.botUsernames.telegram,
        lastError: undefined,
      })
    } catch (err) {
      this.log.error('failed to connect Telegram', {
        event: 'telegram_connect_failed',
        workspaceId,
        error: err,
      })
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: false,
        state: 'error',
        lastError: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private setPlatformRuntime(
    workspaceId: string,
    state: WorkspaceState,
    platform: PlatformType,
    patch: Partial<MessagingPlatformRuntimeInfo>,
  ): void {
    const previous = state.runtime[platform] ?? createRuntime(platform, false)
    const next: MessagingPlatformRuntimeInfo = {
      ...previous,
      ...patch,
      platform,
      updatedAt: Date.now(),
    }
    state.runtime[platform] = next
    this.emitPlatformStatus(workspaceId, platform, next)
  }

  private emitBindingChanged(workspaceId: string): void {
    this.opts.publishEvent?.(
      RPC_CHANNELS.messaging.BINDING_CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  private emitPendingChanged(workspaceId: string): void {
    // 通道名与 BINDING_CHANGED 对称。Phase 3 会接上 RPC 通道常量；
    // 目前常量缺失时这里是 no-op。
    const channel = (
      RPC_CHANNELS.messaging as Record<string, string | undefined>
    ).PENDING_CHANGED
    if (!channel) return
    this.opts.publishEvent?.(
      channel,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  // -------------------------------------------------------------------------
  // 权限控制 —— workspace owners + 每个 binding 的 allow list
  // -------------------------------------------------------------------------

  /**
   * 对 Telegram 平台配置做 patch，保留调用方未涉及的字段。
   * 关键：每次 Telegram 配置写入都必须走这个 helper —— 直接
   * `configStore.update({ platforms: { telegram: {...} } })` 会悄悄把
   * 持久化状态里的 `owners` / `accessMode` / `supergroup` / `enabled` 丢掉，
   * 因为 `ConfigStore.update` 对 `platforms` 做浅合并，但每个平台的值是整体替换。
   *
   * `ensureMessagingEnabled` 会把顶层 `enabled` 标志置为 true
   *（save-token / connect 流程使用）。为 false 时，`enabled` 保持原样。
   */
  private patchTelegramConfig(
    workspaceId: string,
    patch: Partial<NonNullable<MessagingConfig['platforms']['telegram']>>,
    options: { ensureMessagingEnabled?: boolean } = {},
  ): MessagingConfig {
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    const cfg = state.configStore.get()
    const tg = cfg.platforms.telegram ?? { enabled: true }
    return state.configStore.update({
      enabled: options.ensureMessagingEnabled ? true : cfg.enabled,
      platforms: {
        ...cfg.platforms,
        telegram: { ...tg, ...patch },
      },
    })
  }

  /**
   * 当且仅当平台的 owners 列表当前为空时，把 `candidate` 追加进去。
   * 返回（可能未变的）列表。gateway 的 `/pair` 流程用它来引导第一个 owner。
   */
  private async seedFirstOwner(
    workspaceId: string,
    platform: PlatformType,
    candidate: PlatformOwner,
  ): Promise<PlatformOwner[]> {
    if (platform !== 'telegram') return []
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    const cfg = state.configStore.get()
    const currentOwners = cfg.platforms.telegram?.owners ?? []
    if (currentOwners.length > 0) return currentOwners

    const nextOwners: PlatformOwner[] = [candidate]
    // 没有显式选择 access mode 的 workspace，一旦有了 owner 就默认为
    // `owner-only`。已存在的 'open' workspace 会被尊重
    //（运营者选择保持公开）。
    this.patchTelegramConfig(workspaceId, {
      accessMode: cfg.platforms.telegram?.accessMode ?? 'owner-only',
      owners: nextOwners,
    })
    this.log.info('seeded first owner', {
      event: 'first_owner_seeded',
      workspaceId,
      platform,
      ownerId: candidate.userId,
    })
    return nextOwners
  }

  getPlatformOwners(workspaceId: string, platform: PlatformType): PlatformOwner[] {
    if (platform !== 'telegram') return []
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    return state.configStore.get().platforms.telegram?.owners ?? []
  }

  setPlatformOwners(
    workspaceId: string,
    platform: PlatformType,
    owners: PlatformOwner[],
  ): PlatformOwner[] {
    if (platform !== 'telegram') {
      throw new Error('Owner lists are only supported on Telegram in this build.')
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    this.patchTelegramConfig(workspaceId, { owners: dedupeOwners(owners) })
    this.emitBindingChanged(workspaceId)
    return state.configStore.get().platforms.telegram?.owners ?? []
  }

  getPlatformAccessMode(workspaceId: string, platform: PlatformType): PlatformAccessMode {
    if (platform !== 'telegram') return 'open'
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    return state.configStore.get().platforms.telegram?.accessMode ?? 'open'
  }

  setPlatformAccessMode(
    workspaceId: string,
    platform: PlatformType,
    mode: PlatformAccessMode,
  ): void {
    if (platform !== 'telegram') {
      throw new Error('Access mode is only supported on Telegram in this build.')
    }
    this.patchTelegramConfig(workspaceId, { accessMode: mode })

    // 锁定语义：把 workspace 切到 `owner-only` 时，必须同时关闭任何仍处于
    // `open` 模式的 binding，否则运营者点了「锁定」、banner 消失，
    // 但旧 binding 仍是公开的 —— 这正是该功能要防止的「虚假安全感」UX。
    if (mode === 'owner-only') {
      this.migrateOpenBindingsToInherit(workspaceId)
    }

    this.emitBindingChanged(workspaceId)
  }

  /**
   * 遍历所有 Telegram binding，把 `accessMode === 'open'` 的都翻成
   * `inherit`（安全默认值）。锁定 workspace 时使用。
   * 仅 Telegram —— 其他平台还没有按 binding 的 access 控制。
   */
  private migrateOpenBindingsToInherit(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    const store = state.gateway.getBindingStore()
    for (const b of store.getAll()) {
      if (b.platform !== 'telegram') continue
      if (b.config.accessMode !== 'open') continue
      store.updateBindingConfig(b.id, { accessMode: 'inherit', allowedSenderIds: [] })
    }
  }

  /** pending senders 在 Settings → Messaging 里以「Pending requests」呈现。 */
  getPendingSenders(workspaceId: string, platform?: PlatformType): PendingSender[] {
    const state = this.workspaces.get(workspaceId)
    if (!state) return []
    return state.gateway.getPendingStore().list(platform)
  }

  dismissPendingSender(
    workspaceId: string,
    platform: PlatformType,
    userId: string,
  ): boolean {
    const state = this.workspaces.get(workspaceId)
    if (!state) return false
    return state.gateway.getPendingStore().dismiss(platform, userId)
  }

  /**
   * 允许一个 pending sender。行为取决于发送方被拒的原因：
   *
   * - `'not-owner'`（workspace 级拒绝）→ 加入平台 `owners`。
   *   结果：发送方可执行 pre-binding 命令，并对
   *   `accessMode === 'inherit'` 的 binding 继承访问权。
   * - `'not-on-binding-allowlist'`（binding 级拒绝）→ 追加到
   *   该 binding 的 `allowedSenderIds`。不动 workspace owners 列表 ——
   *   这堵住了权限提升的隐患：否则被某个敏感 binding 拒绝的 Bob
   *   会被提升为 workspace owner。
   *
   * `entryKey` 标识具体的 pending 行（一个发送方可能有多行 ——
   * 每个 reason/binding 组合一行）。省略时，取该发送方最早的一条匹配条目。
   */
  allowPendingSender(
    workspaceId: string,
    platform: PlatformType,
    userId: string,
    entryKey?: { reason?: PendingSender['reason']; bindingId?: string },
  ): { owners: PlatformOwner[]; bindingId?: string } {
    if (platform !== 'telegram') {
      throw new Error('Owner lists are only supported on Telegram in this build.')
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    const pending = state.gateway.getPendingStore().list(platform)
    const match = pending.find((p) =>
      p.userId === userId &&
      (entryKey?.reason === undefined ||
        (p.reason ?? 'not-owner') === entryKey.reason) &&
      (entryKey?.bindingId === undefined || p.bindingId === entryKey.bindingId),
    )
    if (!match) {
      throw new Error('Pending sender not found — they may have been dismissed.')
    }

    const reason = match.reason ?? 'not-owner'

    if (reason === 'not-on-binding-allowlist') {
      // 追加到该具体 binding 的 allow-list。不动 owners。
      const bindingId = match.bindingId
      if (!bindingId) {
        throw new Error('Pending entry is binding-scoped but has no bindingId.')
      }
      const store = state.gateway.getBindingStore()
      const binding = store.getAll().find((b) => b.id === bindingId)
      if (!binding) {
        // binding 在 reject 与 Allow 之间被解绑了。丢弃陈旧条目，
        // 并抛出一个有意义的错误，让运营者知道必要时需要重新配对。
        store //（故意的 no-op；为工具保留 store 引用）
        state.gateway.getPendingStore().dismiss(platform, userId, {
          reason: 'not-on-binding-allowlist',
          bindingId,
        })
        throw new Error('Binding no longer exists — pending entry dismissed.')
      }
      const next = Array.from(new Set([...binding.config.allowedSenderIds, userId]))
      store.updateBindingConfig(bindingId, {
        allowedSenderIds: next,
        // 防御性：提升后确保 binding 处于 allow-list 模式。
        // 否则一个原来是 'inherit' 的 binding 仍会忽略新的 allowedSenderIds 条目。
        accessMode: binding.config.accessMode === 'allow-list' ? 'allow-list' : 'allow-list',
      })
      state.gateway.getPendingStore().dismiss(platform, userId, {
        reason: 'not-on-binding-allowlist',
        bindingId,
      })
      this.emitBindingChanged(workspaceId)
      const owners = state.configStore.get().platforms.telegram?.owners ?? []
      return { owners, bindingId }
    }

    // reason === 'not-owner'：提升为 workspace owner。
    const cfg = state.configStore.get()
    const existing = cfg.platforms.telegram?.owners ?? []
    if (existing.some((o) => o.userId === userId)) {
      state.gateway.getPendingStore().dismiss(platform, userId)
      return { owners: existing }
    }
    const nextOwners: PlatformOwner[] = [
      ...existing,
      {
        userId: match.userId,
        ...(match.displayName ? { displayName: match.displayName } : {}),
        ...(match.username ? { username: match.username } : {}),
        addedAt: Date.now(),
      },
    ]
    const tg = cfg.platforms.telegram
    this.patchTelegramConfig(workspaceId, {
      owners: nextOwners,
      accessMode: tg?.accessMode ?? 'owner-only',
    })
    // 清掉该发送方的所有 pending 行 —— 他已经是 owner，
    // 所以针对他的任何 binding-allow-list 拒绝都已被 inherit 路径取代。
    state.gateway.getPendingStore().dismiss(platform, userId)
    this.emitBindingChanged(workspaceId)
    return { owners: nextOwners }
  }

  /**
   * 更新单个 binding 的 access 策略。用原地更新的 `updateBindingConfig`
   * 方法，这样 binding 的 `id` 和 `createdAt` 得以保留 ——
   * 任何以 bindingId 为键的东西（审计日志、深链、陈旧的 renderer 闭包）都能继续工作。
   */
  setBindingAccess(
    workspaceId: string,
    bindingId: string,
    access: { mode: BindingAccessMode; allowedSenderIds?: string[] },
  ): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) throw new Error('Workspace not initialised')
    const store = state.gateway.getBindingStore()
    const next = store.updateBindingConfig(bindingId, {
      accessMode: access.mode,
      allowedSenderIds:
        access.mode === 'allow-list' ? [...(access.allowedSenderIds ?? [])] : [],
    })
    if (!next) throw new Error('Binding not found')
    this.emitBindingChanged(workspaceId)
  }

  private emitPlatformStatus(
    workspaceId: string,
    platform: PlatformType,
    status: MessagingPlatformRuntimeInfo,
  ): void {
    this.opts.publishEvent?.(
      RPC_CHANNELS.messaging.PLATFORM_STATUS,
      { to: 'workspace', workspaceId },
      workspaceId,
      platform,
      cloneRuntime(status),
    )
  }

  private hasWhatsAppAuthState(workspaceId: string): boolean {
    const dir = this.getWhatsAppAuthStateDir(workspaceId)
    if (!existsSync(dir)) return false
    try {
      return readdirSync(dir).some((entry) => !entry.startsWith('.'))
    } catch {
      return false
    }
  }

  private getWhatsAppAuthStateDir(workspaceId: string): string {
    return join(this.opts.getMessagingDir(workspaceId), 'whatsapp-auth')
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function toBindingInfo(b: ChannelBinding): MessagingBindingInfo {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    sessionId: b.sessionId,
    platform: b.platform,
    channelId: b.channelId,
    ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
    channelName: b.channelName,
    enabled: b.enabled,
    createdAt: b.createdAt,
    accessMode: b.config.accessMode,
    allowedSenderIds: [...b.config.allowedSenderIds],
  }
}

function isKnownPlatform(p: string): p is PlatformType {
  return p === 'telegram' || p === 'whatsapp' || p === 'lark'
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

function isPlatformConfigured(
  config: { enabled: boolean; platforms: Record<string, { enabled: boolean } | undefined> },
  platform: PlatformType,
): boolean {
  return Boolean(config.enabled && config.platforms[platform]?.enabled)
}

function dedupeOwners(owners: PlatformOwner[]): PlatformOwner[] {
  const map = new Map<string, PlatformOwner>()
  for (const o of owners) {
    if (!o?.userId) continue
    map.set(o.userId, { ...o })
  }
  return Array.from(map.values())
}

function createRuntime(platform: PlatformType, configured: boolean): MessagingPlatformRuntimeInfo {
  return {
    platform,
    configured,
    connected: false,
    state: configured ? 'disconnected' : 'disconnected',
    updatedAt: Date.now(),
  }
}

function cloneRuntime(runtime: MessagingPlatformRuntimeInfo): MessagingPlatformRuntimeInfo {
  return { ...runtime }
}

async function fetchTelegramBotInfo(
  token: string,
): Promise<{ ok: boolean; result: { username?: string; first_name?: string }; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
  return (await res.json()) as {
    ok: boolean
    result: { username?: string; first_name?: string }
    description?: string
  }
}
