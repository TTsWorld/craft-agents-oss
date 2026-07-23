/**
 * index.ts — TelegramAdapter：基于 grammY 的进程内适配器。
 *
 * Phase 1：轮询模式、仅文本、仅 DM。
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Bot, InputFile, type Context } from 'grammy'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  SendOptions,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
} from '../../types'
import { formatForTelegram } from './format'

/**
 * `getChatInfo` 返回的可区分聊天元数据。Phase A 的超级群配对流程用它校验
 * 用户确实在一个论坛超级群里输入了 `/pair`，然后才把它绑定为 workspace 的超级群。
 */
export type TelegramChatInfo =
  | { type: 'supergroup'; isForum: boolean; title: string }
  | { type: 'group' | 'channel' | 'private'; title?: string }

/**
 * 下载附件的硬上限。与 `@craft-agent/shared/utils/files` 里的 `MAX_FILE_SIZE` 一致——
 * 超过这个大小的文件反正也会被 `readFileAttachment` 拒绝，所以我们在适配器里
 * 快速失败并给用户一条可见回复，而不是静默丢弃。
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * 当 Telegram 的 `file_path` 缺失或没有扩展名时使用的 mime → 扩展名最小回退表。
 * 有意保持很小——未知的一律变成 `.bin`，`readFileAttachment` 会归类为 'unknown'。
 */
const MIME_EXT_FALLBACK: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
}

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * 让一个 promise 与超时赛跑。如果在 `p` 落定前过了 `ms` 毫秒，就以带标签的错误 reject。
 * 用于把 grammY 在 `bot.init()` / `deleteWebhook()` 上静默重试导致的卡死，
 * 变成真正可操作的错误。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[telegram] ${label} timed out after ${ms}ms`)),
      ms,
    )
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * 为结构化日志解开错误。grammY 的 HttpError 把真正的 fetch/undici 原因包在
 * `.error` 字段里；否则 electron-log 的 JSON 序列化器会看到一个空对象，
 * 因为 Error 自身字段不可枚举。最多向上回溯 3 层包裹（HttpError -> cause -> cause）。
 */
function describeError(err: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) return { truncated: true }
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    }
    const code = (err as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const grammyInner = (err as { error?: unknown }).error
    if (grammyInner !== undefined) out.error = describeError(grammyInner, depth + 1)
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = describeError(cause, depth + 1)
    if (err.stack) out.stack = err.stack.split('\n').slice(0, 4).join('\n')
    return out
  }
  if (err && typeof err === 'object') return { value: String(err), raw: err as object }
  return { value: String(err) }
}

/**
 * 仅 DM 的守卫。保留是因为测试直接用到它；新代码路径应调用
 * `isAcceptedChat()`，后者还接受 workspace 配置的超级群（论坛）。
 */
export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private'
}

/**
 * 判断一条入站 update 是否应被处理。
 *
 * - DM（`private` 聊天）始终接受 —— 与 Phase 1 一致。
 * - 当 workspace 配对了一个超级群时，那个确切的 `chat.id` 也被接受
 *  （论坛话题就在它里面）。
 * - 其他一切（其他群、频道、未显式配置就被加入的基础群）一律丢弃。
 *
 * 这里有意不在群/话题层面做发送方级鉴权 —— 在 Settings 里配对超级群就是
 * 每个 workspace 的同意边界，而话题级 binding 决定每个话题路由到哪个 session。
 */
export function isAcceptedChat(ctx: Context, supergroupChatId?: string): boolean {
  const chat = ctx.chat
  if (!chat) return false
  if (chat.type === 'private') return true
  if (!supergroupChatId) return false
  return String(chat.id) === supergroupChatId
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: 10,
    maxMessageLength: 4096,
    markdown: 'v2',
    // 本适配器用轮询（grammY Bot#start）。webhook 路径没有接入 Electron 主进程，
    // 所以声明 webhookSupport 会误导无头服务器的 bootstrap。在有正式 webhook handler
    // 之前保持 false。
    webhookSupport: false,
  }

  /** 获取机器人资料（用户名、显示名），用于 UI 提示。 */
  async getBotInfo(): Promise<{ id: number; username?: string; firstName?: string } | null> {
    if (!this.bot) return null
    try {
      const me = await this.bot.api.getMe()
      return { id: me.id, username: me.username, firstName: me.first_name }
    } catch {
      return null
    }
  }

  private bot: Bot | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private connected = false
  private destroyed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private log: MessagingLogger = NOOP_LOGGER
  /**
   * 本适配器接受非 DM 消息的超级群 chatId。在用户于 Settings 里配对/取消配对
   * 超级群后，通过 `setAcceptedSupergroupChatId()` 在运行时更新，这样重新配置时
   * 无需重启轮询。
   */
  private supergroupChatId: string | undefined

  /**
   * 每丢弃一条非接受的 update 就输出一条结构化日志。刻意用 `info`（不是 `debug`），
   * 这样一个察觉「机器人在我的群里没反应」的用户可以不用切日志级别就能从日志确认。
   */
  private logRejectedChat(handler: string, ctx: Context): void {
    this.log.info('[telegram] ignored non-accepted chat update', {
      event: 'telegram_chat_rejected',
      handler,
      chatType: ctx.chat?.type,
      chatId: ctx.chat?.id,
    })
  }

  /** 对接受的超级群 chatId 做幂等的运行时重配置。 */
  setAcceptedSupergroupChatId(chatId: string | undefined): void {
    this.supergroupChatId = chatId
    this.log.info('[telegram] accepted supergroup updated', {
      event: 'telegram_supergroup_set',
      supergroupChatId: chatId ?? null,
    })
  }

  /**
   * 通过 Bot API 解析聊天元数据。任何失败（网络、「找不到聊天」、缺权限等）都返回 `null`。
   * 调用方需显式处理 null —— 对超级群配对流程而言，这意味着拒绝绑定，而不是猜默认值。
   *
   * 论坛超级群是唯一能承载话题的聊天类型。`isForum` 标志区分普通超级群与开启了话题的超级群，
   * Phase B 的 `createForumTopic` 依赖它。
   */
  async getChatInfo(chatId: string): Promise<TelegramChatInfo | null> {
    if (!this.bot) return null
    try {
      const chat = await this.bot.api.getChat(Number(chatId))
      if (chat.type === 'supergroup') {
        return {
          type: 'supergroup',
          isForum: Boolean((chat as { is_forum?: boolean }).is_forum),
          title: chat.title ?? `Group ${chatId}`,
        }
      }
      return {
        type: chat.type,
        title: 'title' in chat && typeof chat.title === 'string' ? chat.title : undefined,
      }
    } catch {
      return null
    }
  }

  /**
   * Telegram 专用辅助：从入站 update 中提取可选的 `message_thread_id`。
   * 对 DM 和 General 话题返回 undefined（Telegram 在这两种情况会省略该字段）。
   */
  private extractThreadId(ctx: Context): number | undefined {
    const tid = ctx.message?.message_thread_id
    return typeof tid === 'number' ? tid : undefined
  }

  async initialize(config: PlatformConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Telegram bot token is required')
    }

    this.log = config.logger ?? NOOP_LOGGER
    this.bot = new Bot(config.token)
    if (config.acceptedSupergroupChatId) {
      this.supergroupChatId = config.acceptedSupergroupChatId
    }

    // 处理入站文本消息。
    //
    // 对 `isAcceptedChat` 做了一条例外：`/pair <code>` 从*任何*聊天都允许，
    // 即使 workspace 还没配对这个聊天。这是注册超级群的引导机制——没有这个例外，
    // 在一个全新超级群里输入 `/pair` 会被静默丢弃（鸡生蛋蛋生鸡）。
    // 配对码是 workspace 作用域、一次性、5 分钟 TTL、且按发送方限速，所以这个例外是有界的。
    this.bot.on('message:text', async (ctx: Context) => {
      if (!this.messageHandler || !ctx.message || !ctx.chat) return
      const text = ctx.message.text ?? ''
      const isPairAttempt = /^\/pair(\s|$|@)/i.test(text)
      if (!isAcceptedChat(ctx, this.supergroupChatId) && !isPairAttempt) {
        this.logRejectedChat('message:text', ctx)
        return
      }

      const threadId = this.extractThreadId(ctx)
      const msg: IncomingMessage = {
        platform: 'telegram',
        channelId: String(ctx.chat.id),
        ...(threadId !== undefined ? { threadId } : {}),
        messageId: String(ctx.message.message_id),
        senderId: String(ctx.from?.id ?? ''),
        senderName: ctx.from?.first_name ?? undefined,
        ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
        ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
        text: ctx.message.text ?? '',
        timestamp: ctx.message.date * 1000,
        raw: ctx.message,
      }

      await this.messageHandler(msg)
    })

    // 附件 handler —— 图片、文档、语音、视频、音频。
    // 每个都把 Telegram 的源字段映射到一个公共 helper，把二进制下载到临时文件，
    // 然后发出一条 `attachments[0].localPath` 已设置的 IncomingMessage。
    // router 通过 readFileAttachment() 解析该路径，并把 FileAttachment 转发给 session。
    this.bot.on('message:photo', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:photo', ctx)
        return
      }
      const photos = ctx.message?.photo
      // Telegram 返回多种尺寸；最后一个是最大的原图。
      const largest = photos?.[photos.length - 1]
      if (!largest) return
      await this.emitAttachmentMessage(ctx, {
        type: 'photo',
        fileId: largest.file_id,
        fileSize: largest.file_size,
        mimeType: 'image/jpeg', // Telegram 会把图片重新编码为 JPEG
      })
    })

    this.bot.on('message:document', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:document', ctx)
        return
      }
      const doc = ctx.message?.document
      if (!doc) return
      await this.emitAttachmentMessage(ctx, {
        type: 'document',
        fileId: doc.file_id,
        fileName: doc.file_name,
        fileSize: doc.file_size,
        mimeType: doc.mime_type,
      })
    })

    this.bot.on('message:voice', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:voice', ctx)
        return
      }
      const voice = ctx.message?.voice
      if (!voice) return
      await this.emitAttachmentMessage(ctx, {
        type: 'voice',
        fileId: voice.file_id,
        fileSize: voice.file_size,
        mimeType: voice.mime_type ?? 'audio/ogg',
      })
    })

    this.bot.on('message:video', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:video', ctx)
        return
      }
      const video = ctx.message?.video
      if (!video) return
      await this.emitAttachmentMessage(ctx, {
        type: 'video',
        fileId: video.file_id,
        fileName: video.file_name,
        fileSize: video.file_size,
        mimeType: video.mime_type ?? 'video/mp4',
      })
    })

    this.bot.on('message:audio', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:audio', ctx)
        return
      }
      const audio = ctx.message?.audio
      if (!audio) return
      await this.emitAttachmentMessage(ctx, {
        type: 'audio',
        fileId: audio.file_id,
        fileName: audio.file_name,
        fileSize: audio.file_size,
        mimeType: audio.mime_type ?? 'audio/mpeg',
      })
    })

    // 处理回调查询（按钮点击）
    this.bot.on('callback_query:data', async (ctx: Context) => {
      if (!this.buttonHandler || !ctx.callbackQuery) return
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('callback_query:data', ctx)
        // 应答这个 callback 让 Telegram 停止转圈，但不路由它——
        // 与消息 handler 同理。
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }

      await ctx.answerCallbackQuery().catch(() => {})

      // 按钮依附于某条消息；读取该消息的 thread id，确保后续回复
      //（允许/拒绝 ack、计划接受确认）发回到 prompt 原来的话题里。
      const threadId = typeof ctx.callbackQuery.message?.message_thread_id === 'number'
        ? ctx.callbackQuery.message.message_thread_id
        : undefined

      const press: ButtonPress = {
        platform: 'telegram',
        channelId: String(ctx.chat?.id ?? ''),
        ...(threadId !== undefined ? { threadId } : {}),
        messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
        senderId: String(ctx.from?.id ?? ''),
        ...(ctx.from?.first_name ? { senderName: ctx.from.first_name } : {}),
        ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
        ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
        buttonId: ctx.callbackQuery.data ?? '',
        data: ctx.callbackQuery.data ?? undefined,
      }

      // 针对 #726 的诊断：记录 callback 到达时间与 handler 返回时间，
      // 这样从日志就能判断是 gateway 慢，还是 grammY 的顺序轮询卡在了前一个 update 上。
      const receivedAt = Date.now()
      this.log.info('[telegram] callback_query received', {
        event: 'telegram_callback_received',
        buttonId: press.buttonId,
        senderId: press.senderId,
      })
      try {
        await this.buttonHandler(press)
      } finally {
        this.log.info('[telegram] callback_query handler returned', {
          event: 'telegram_callback_handled',
          buttonId: press.buttonId,
          senderId: press.senderId,
          elapsedMs: Date.now() - receivedAt,
        })
      }
    })

    this.log.info('[telegram] initializing')

    // 在 bot.init() 之前先清掉可能已存在的 webhook。grammY 的 Api client 不依赖
    // init() 就能工作（init() 只是缓存 getMe），而如果有 webhook 存在
    //（之前某次 app 运行、另一个 app、或 BotFather 设置的），getUpdates 会返回空，
    // 轮询会静默地收不到任何消息。先做这一步，意味着即使 init() 很慢或卡住，
    // 也不会阻塞 webhook 的清理。
    // drop_pending_updates=false 会保留用户保存 token 之前就入队的消息。
    try {
      await withTimeout(
        this.bot.api.deleteWebhook({ drop_pending_updates: false }),
        10_000,
        'deleteWebhook',
      )
      this.log.info('[telegram] deleteWebhook ok')
    } catch (err) {
      this.log.warn('[telegram] deleteWebhook failed (non-fatal):', describeError(err))
    }

    // 提前暴露 token/网络错误（getMe）。没有这个超时的话，grammY 会无限重试
    // 瞬时错误且不打日志，从外部看与死锁无异。
    try {
      await withTimeout(this.bot.init(), 10_000, 'bot.init')
      this.log.info('[telegram] bot.init ok', {
        username: this.bot.botInfo?.username,
      })
    } catch (err) {
      this.log.error('[telegram] bot.init failed:', describeError(err))
      throw err
    }

    this.destroyed = false
    this.reconnectAttempts = 0
    this.startPolling()
    // 不要在这里设置 this.connected = true —— 等到 onStart 回调。
  }

  /**
   * 把一个 Telegram 文件下载到临时路径，然后用得到的 IncomingMessage 调用消息 handler。
   * 集中在这里实现，这样五个 `bot.on(...)` handler 只需挑出正确的源字段即可。
   *
   * 失败（超尺寸、404、网络）会通过 `ctx.reply()` 回报给发送方并记日志。
   * 这种情况下消息不会被转发 —— session 不该因为我们交付不了的附件而被唤醒。
   */
  private async emitAttachmentMessage(
    ctx: Context,
    meta: {
      type: IncomingAttachment['type']
      fileId: string
      fileName?: string
      fileSize?: number
      mimeType?: string
    },
  ): Promise<void> {
    if (!this.messageHandler || !ctx.message || !ctx.chat || !this.bot) return

    // 在请求 file API 之前先做尺寸守卫 —— 当 Telegram 已经提前告诉我们大小时，
    // 可以省掉这次往返。
    if (meta.fileSize !== undefined && meta.fileSize > MAX_ATTACHMENT_BYTES) {
      this.log.warn('[telegram] attachment too large, dropping', {
        type: meta.type,
        fileSize: meta.fileSize,
      })
      await ctx.reply(
        `Attachment too large (>${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB). Not forwarded.`,
      ).catch(() => {})
      return
    }

    let downloaded: { localPath: string; fileName: string; fileSize: number }
    try {
      downloaded = await this.downloadToTemp(
        meta.fileId,
        meta.fileName ?? `${meta.type}-${Date.now()}`,
        meta.mimeType,
      )
    } catch (err) {
      this.log.error('[telegram] attachment download failed:', describeError(err))
      await ctx.reply(
        'Failed to download your attachment. Please try again.',
      ).catch(() => {})
      return
    }

    const attachment: IncomingAttachment = {
      type: meta.type,
      fileId: meta.fileId,
      fileName: downloaded.fileName,
      mimeType: meta.mimeType,
      fileSize: downloaded.fileSize,
      localPath: downloaded.localPath,
    }

    const threadId = this.extractThreadId(ctx)
    const msg: IncomingMessage = {
      platform: 'telegram',
      channelId: String(ctx.chat.id),
      ...(threadId !== undefined ? { threadId } : {}),
      messageId: String(ctx.message.message_id),
      senderId: String(ctx.from?.id ?? ''),
      senderName: ctx.from?.first_name ?? undefined,
      ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
      ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
      text: ctx.message.caption ?? '',
      attachments: [attachment],
      timestamp: ctx.message.date * 1000,
      raw: ctx.message,
    }

    await this.messageHandler(msg)
  }

  /**
   * 把一个 Telegram `file_id` 解析成本地路径：先调 `getFile()` 拿到远端路径，
   * 再从 Bot API file host 取回二进制，写到 OS 的 temp 目录。对实际下载大小
   * 强制执行 `MAX_ATTACHMENT_BYTES` 检查，以防 `getFile` 没有上报尺寸。
   */
  private async downloadToTemp(
    fileId: string,
    fallbackName: string,
    mimeType: string | undefined,
  ): Promise<{ localPath: string; fileName: string; fileSize: number }> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) {
      throw new Error(`getFile returned no file_path for ${fileId}`)
    }
    if (file.file_size !== undefined && file.file_size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${file.file_size} bytes`)
    }

    // 扩展名：优先用 Telegram file_path 里带的扩展名（通常是
    // `photos/file_123.jpg` 之类），其次回退到 mime 映射表，最后才用 `.bin`。
    let ext = extname(file.file_path)
    if (!ext && mimeType && MIME_EXT_FALLBACK[mimeType]) {
      ext = MIME_EXT_FALLBACK[mimeType]
    }
    if (!ext) ext = '.bin'

    // 规范化 fileName —— 确保它带上解析出的扩展名，这样 readFileAttachment
    // 基于扩展名的类型检测才能生效。
    let fileName = fallbackName
    if (!extname(fileName)) fileName = `${fileName}${ext}`

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large after download: ${buf.byteLength} bytes`)
    }

    const localPath = join(
      tmpdir(),
      `craft-agent-messaging-${randomBytes(8).toString('hex')}${ext}`,
    )
    writeFileSync(localPath, buf)
    return { localPath, fileName, fileSize: buf.byteLength }
  }

  /**
   * 启动轮询。grammY 的 bot.start() 会一直跑到 stop() 被调用或发生致命错误。
   * 遇到意外失败时，我们用指数退避调度一次重连，让瞬时问题
   *（网络抖动、来自一个很快退出的竞争实例的 409）无需用户介入就能自愈。
   *
   * 409 Conflict 表示有另一个轮询者活跃 —— 我们在第一次重试前等久一点，
   * 给那个实例留出退出的时间。
   */
  private startPolling(): void {
    if (this.destroyed || !this.bot) return

    this.bot.start({
      onStart: () => {
        this.connected = true
        this.reconnectAttempts = 0
        this.log.info('[telegram] polling started')
        this.bot?.api.getWebhookInfo().then(
          (info) => this.log.info('[telegram] webhook state after start:', {
            url: info.url || null,
            pending_update_count: info.pending_update_count,
          }),
          () => {},
        )
      },
    }).catch((err: unknown) => {
      this.connected = false
      this.log.error('[telegram] polling stopped with error:', describeError(err))
      if (!this.destroyed) {
        this.scheduleReconnect(err)
      }
    })
  }

  private scheduleReconnect(err: unknown): void {
    if (this.destroyed || !this.bot) return

    this.reconnectAttempts++
    // 409 = 有另一个轮询者在竞争；首次重试前等 30 秒，给对方进程留出退出的机会。
    // 其他错误从 5 秒开始。
    const is409 = err instanceof Error && err.message.includes('409')
    const baseDelay = is409 ? 30_000 : 5_000
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), 5 * 60_000)

    this.log.warn('[telegram] scheduling reconnect', {
      event: 'telegram_reconnect_scheduled',
      attempt: this.reconnectAttempts,
      delayMs: delay,
      is409,
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.destroyed || !this.bot) return
      this.log.info('[telegram] attempting reconnect', {
        event: 'telegram_reconnect_attempt',
        attempt: this.reconnectAttempts,
      })
      this.startPolling()
    }, delay)
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.connected = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
    this.buttonHandler = handler
  }

  async sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = formatForTelegram(text)
    const sent = await this.bot.api.sendMessage(
      Number(channelId),
      formatted,
      threadParams(opts),
    )
    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async editMessage(channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = formatForTelegram(text)
    // editMessageText 以 (chat_id, message_id) 为键 —— Telegram 在这里不接受
    // message_thread_id。我们接受这个选项是为了调用方的统一性，但忽略它。
    await this.bot.api.editMessageText(Number(channelId), Number(messageId), formatted)
  }

  async sendButtons(channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const keyboard = {
      inline_keyboard: buttons.map((b) => [{
        text: b.label,
        callback_data: b.id,
      }]),
    }

    const sent = await this.bot.api.sendMessage(Number(channelId), text, {
      reply_markup: keyboard,
      ...threadParams(opts),
    })

    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async sendTyping(channelId: string, opts?: SendOptions): Promise<void> {
    if (!this.bot) return
    await this.bot.api
      .sendChatAction(Number(channelId), 'typing', threadParams(opts))
      .catch(() => {})
  }

  async sendFile(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const inputFile = new InputFile(file, filename)
    const sent = await this.bot.api.sendDocument(
      Number(channelId),
      inputFile,
      { caption, ...threadParams(opts) },
    )

    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async clearButtons(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    if (!this.bot) return
    try {
      // editMessageReplyMarkup 也只以 (chat_id, message_id) 为键。
      await this.bot.api.editMessageReplyMarkup(Number(channelId), Number(messageId), {
        reply_markup: { inline_keyboard: [] },
      })
    } catch {
      // 非致命：消息可能已被用户删除或已经清空过。
    }
  }

  /**
   * Phase B 预备：在超级群里创建一个新的论坛话题。Telegram 返回
   * `{ message_thread_id, name, ... }`；我们对外暴露一个规范化的形状。
   *
   * 要求机器人在超级群里拥有「Manage Topics」管理员权限。如果调用失败
   *（缺权限、聊天不是论坛等），错误会向上冒泡，让调用方能够呈现出来。
   *
   * `iconColor` 在这个 stub 里有意省略 —— grammY 的类型只接受六个
   * Telegram 定义的调色板整数。Phase B 在自动化功能真正要选颜色时，
   * 我们会把它正确地接上。
   */
  async createForumTopic(
    chatId: string,
    name: string,
  ): Promise<{ threadId: number; name: string }> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const result = await this.bot.api.createForumTopic(Number(chatId), name)
    return { threadId: result.message_thread_id, name: result.name }
  }
}

/**
 * 构造传给 grammY API 调用的 `{ message_thread_id }` 片段。
 * 当没有请求 thread 时返回空对象，这样展开操作是个 no-op，
 * Telegram 也就收不到 `message_thread_id`（正是 General 话题 / DM 场景所期望的）。
 */
function threadParams(opts?: SendOptions): { message_thread_id?: number } {
  if (opts?.threadId === undefined) return {}
  return { message_thread_id: opts.threadId }
}
