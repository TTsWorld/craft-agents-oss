/**
 * index.ts — LarkAdapter：Lark / 飞书进程内适配器。
 *
 * 传输方式：通过 `@larksuiteoapi/node-sdk` 的 `WSClient` 做长轮询。无需公网
 * webhook URL（适合桌面 / electron 场景）。生命周期形状与 Telegram 适配器一致，
 * 只是底层 SDK 不同。
 *
 * Phase 1 范围（仅文本）：接收 DM 和群 @提及里的文本、发送文本回复、支持
 * `/pair` 风格命令。Phase 2 在此之上叠加消息编辑、交互卡片、附件，以及
 * Markdown→post 富文本格式化。
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as lark from '@larksuiteoapi/node-sdk'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
  SendOptions,
} from '../../types'
import {
  formatForLarkPost,
  wrapAsTrivialPost,
  type LarkPost,
} from './format'
import {
  buildLarkCard,
  buildClearedCard,
  isLarkEditExpiredError,
  LARK_MAX_BUTTONS,
} from './card'

/**
 * 下载附件的硬上限。与 Telegram 的 MAX_ATTACHMENT_BYTES 一致——
 * 超过这个大小的文件反正也会被 `readFileAttachment` 拒绝，所以我们在适配器里
 * 快速失败并给用户一条可见回复。
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Lark/飞书机器人的凭据载荷。
 *
 * 以 JSON 字符串形式存储在 `messaging_bearer` 凭据行里（每个 workspace+platform 一行）。
 * 只有这一套现有 schema，没有迁移。
 */
export interface LarkCredentials {
  appId: string
  appSecret: string
  /**
   * 对接哪个开放平台域名。Lark 和飞书是两套独立生态——
   * Lark 机器人只能对接 open.larksuite.com，飞书机器人只能对接 open.feishu.cn。
   */
  domain: 'lark' | 'feishu'
}

/**
 * 从 `PlatformConfig.token` 解析 JSON 编码的凭据。
 *
 * 输入格式错误时抛出明确的消息——在 registry 里体现为
 * `state: 'error'` 且带用户可读的 `lastError`。
 */
export function parseLarkCredentials(token: string | undefined): LarkCredentials {
  if (!token) throw new Error('Lark credentials are missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(token)
  } catch {
    throw new Error('Lark credentials are not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Lark credentials must be a JSON object')
  }
  const { appId, appSecret, domain } = parsed as Record<string, unknown>
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new Error('Lark credentials are missing `appId`')
  }
  if (typeof appSecret !== 'string' || appSecret.length === 0) {
    throw new Error('Lark credentials are missing `appSecret`')
  }
  if (domain !== 'lark' && domain !== 'feishu') {
    throw new Error('Lark credentials `domain` must be "lark" or "feishu"')
  }
  return { appId, appSecret, domain }
}

/**
 * 把我们的 `'lark' | 'feishu'` 选择器映射为 SDK 的 `Domain` 枚举。
 */
function resolveLarkDomain(domain: 'lark' | 'feishu'): lark.Domain {
  return domain === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark
}

/**
 * 去掉 Lark 文本消息内容开头的 `<at user_id="...">…</at> ` 前缀。
 * Lark 会把 @提及作为字面量前置到内容里，但 agent 只关心 @之后的部分。
 */
function stripMentionPrefix(text: string): string {
  return text.replace(/^<at[^>]*>[^<]*<\/at>\s*/, '').trim()
}

/**
 * 对 SDK `Client` 中我们实际调用的方法做窄投影。
 * SDK 的完整类型联合体极其庞大（约 25 万行），且在小版本间形状会变；
 * 手写一个固定接口能让适配器保持松耦合，也让 ts 类型检查器满意。
 */
interface LarkClient {
  im: {
    message: {
      create: (args: {
        params: { receive_id_type: 'chat_id' | 'open_id' | 'union_id' }
        data: { receive_id: string; msg_type: string; content: string; uuid?: string }
      }) => Promise<{ data?: { message_id?: string } } | null>
      update: (args: {
        path: { message_id: string }
        data: { msg_type: string; content: string }
      }) => Promise<unknown>
      patch: (args: {
        path: { message_id: string }
        data: { content: string }
      }) => Promise<unknown>
    }
    file: {
      create: (args: {
        data: { file_type: string; file_name: string; file: Buffer }
      }) => Promise<{ file_key?: string } | null>
    }
    image: {
      create: (args: {
        data: { image_type: 'message' | 'avatar'; image: Buffer }
      }) => Promise<{ image_key?: string } | null>
    }
  }
}

/**
 * SDK 的 `EventDispatcher.parse()` 解开 v2 信封后的扁平形状。
 * dispatcher 在调用 handler 前把 `{schema, header, event}` 合并成单个对象，
 * 所以 payload 字段落在顶层——没有外层的 `.event` 访问器。
 */
interface LarkMessageEvent {
  sender: {
    sender_id?: { user_id?: string; open_id?: string; union_id?: string }
  }
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
    create_time: string
    mentions?: Array<{ key: string; id: { user_id?: string }; name: string }>
  }
}

/**
 * SDK 的 `EventDispatcher.parse()` 拍平 v2 信封后的卡片动作点击事件。
 * Schema 2.0 把 chat id 嵌在 `context` 下而非顶层——同时处理两种形状，
 * 使同一套代码路径对 v1 和 v2 卡片都生效。
 */
interface LarkCardActionEvent {
  operator?: { user_id?: string; open_id?: string; union_id?: string }
  /** Schema 1.0 中 chat id 的位置。 */
  open_chat_id?: string
  /** Schema 2.0 的位置 —— `context.open_chat_id` 等。 */
  context?: {
    open_chat_id?: string
    open_message_id?: string
  }
  action?: {
    value?: unknown
    tag?: string
  }
}

export class LarkAdapter implements PlatformAdapter {
  readonly platform = 'lark' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: LARK_MAX_BUTTONS,
    maxMessageLength: 30000,
    markdown: 'lark-post',
    webhookSupport: false,
  }

  private client: LarkClient | null = null
  private wsClient: lark.WSClient | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private connected = false
  private log: MessagingLogger = NOOP_LOGGER
  /**
   * 跟踪每条出站消息的线上 `msg_type`，以便 `editMessage` 能正确分派到
   * `update`（text/post）还是 `patch`（交互卡片）。Lark 要求新的 `msg_type`
   * 与原消息一致。
   */
  private sentMsgTypes = new Map<string, 'text' | 'post' | 'interactive'>()

  /** 获取机器人资料，用于 UI 提示。 */
  async getBotInfo(): Promise<{ name?: string } | null> {
    if (!this.client) return null
    try {
      // SDK 的 `bot.v3.info.get`（无参）返回 `{ data: { bot: { app_name } } }`。
      // 通过 unknown 做不安全转换 —— bot 命名空间不在我们的窄投影里。
      const c = this.client as unknown as {
        bot: { v3: { info: { get: () => Promise<{ data?: { bot?: { app_name?: string } } }> } } }
      }
      const result = await c.bot.v3.info.get()
      const name = result.data?.bot?.app_name
      return name ? { name } : null
    } catch {
      return null
    }
  }

  async initialize(config: PlatformConfig): Promise<void> {
    this.log = config.logger ?? NOOP_LOGGER
    const creds = parseLarkCredentials(config.token)
    const sdkDomain = resolveLarkDomain(creds.domain)

    // 构造 REST client（发送 + 查询都走它）。
    this.client = new lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: sdkDomain,
      loggerLevel: lark.LoggerLevel.warn,
    }) as unknown as LarkClient

    // 长连接 WS client + 事件分发器。
    //
    // 生命周期钩子显式打日志，便于区分「socket 从未打开」与
    // 「socket 打开了但没有事件」——后者通常意味着 App 的权限范围或事件订阅
    // 在开放平台侧配置错了，否则我们这边看不到。
    this.wsClient = new lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: sdkDomain,
      loggerLevel: lark.LoggerLevel.info,
      onReady: () => {
        this.log.info('[lark] ws ready', { event: 'lark_ws_ready' })
      },
      onError: (err: unknown) => {
        this.log.error('[lark] ws error', {
          event: 'lark_ws_error',
          error: err instanceof Error ? err.message : String(err),
        })
      },
      onReconnecting: () => {
        this.log.info('[lark] ws reconnecting', { event: 'lark_ws_reconnecting' })
      },
      onReconnected: () => {
        this.log.info('[lark] ws reconnected', { event: 'lark_ws_reconnected' })
      },
    } as unknown as ConstructorParameters<typeof lark.WSClient>[0])

    // SDK 的 `register` 类型是一个覆盖数百个事件名的宽泛联合。
    // 通过 `unknown` 对 handler 块做一次转换以保持适配器可读性；
    // 真正的 payload 形状由上面每个 handler 内部的转换处理。
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleIncomingMessage(data as LarkMessageEvent)
      },
      'card.action.trigger': async (data: unknown) => {
        await this.handleCardAction(data as LarkCardActionEvent)
        // Lark 期望一个同步返回，可能用于补丁卡片；我们返回空对象（不做补丁），
        // 让 `clearButtons` 通过 binding 现有的点击后流程异步做视觉清理。
        return {}
      },
    } as unknown as Parameters<lark.EventDispatcher['register']>[0])

    await this.wsClient.start({ eventDispatcher })
    this.connected = true
    this.log.info('[lark] connected', {
      event: 'lark_connected',
      domain: creds.domain,
    })
  }

  async destroy(): Promise<void> {
    // SDK 的 WSClient 目前在公开类型里没有暴露 `.stop()` 方法——
    // 它在进程退出时自行拆解。我们把引用置空以便能重新初始化；
    // 底层 socket 会被垃圾回收。
    this.wsClient = null
    this.client = null
    this.connected = false
    this.sentMsgTypes.clear()
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

  // -------------------------------------------------------------------------
  // 出站 —— 发送、编辑、文件、卡片
  // -------------------------------------------------------------------------

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    if (!this.client) throw new Error('Lark adapter is not connected')
    const formatted = formatForLarkPost(text)
    const { msgType, content } =
      formatted.kind === 'text'
        ? { msgType: 'text' as const, content: JSON.stringify({ text: formatted.text }) }
        : { msgType: 'post' as const, content: JSON.stringify(formatted.post) }

    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: channelId, msg_type: msgType, content },
    })
    const messageId = result?.data?.message_id ?? ''
    if (messageId) this.sentMsgTypes.set(messageId, msgType)
    return { platform: 'lark', channelId, messageId }
  }

  async editMessage(
    channelId: string,
    messageId: string,
    text: string,
    _opts?: SendOptions,
  ): Promise<void> {
    if (!this.client) throw new Error('Lark adapter is not connected')
    const originalType = this.sentMsgTypes.get(messageId) ?? 'text'

    // 卡片走 patch，不走 update——API 不同。
    if (originalType === 'interactive') {
      // 编辑一张活动卡片会替换其文本正文但保留按钮。
      // 对于 renderer 走的纯文本编辑路径，我们回退到一个清空卡片的 patch
      //（有文本无按钮），与 Telegram 上「最终文本编辑移除按钮行」的行为一致。
      try {
        await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(buildClearedCard(text)) },
        })
      } catch (err: unknown) {
        if (isLarkEditExpiredError(err)) return
        throw err
      }
      return
    }

    // text 或 post —— 匹配原类型，这样 Lark 才会接受 update。
    let content: string
    let msgType: 'text' | 'post'
    if (originalType === 'post') {
      // 如果新内容带格式，就格式化它；否则包装成最简 post，
      // 让 msg_type 仍与原消息一致。
      const formatted = formatForLarkPost(text)
      const post: LarkPost = formatted.kind === 'post' ? formatted.post : wrapAsTrivialPost(text)
      content = JSON.stringify(post)
      msgType = 'post'
    } else {
      content = JSON.stringify({ text })
      msgType = 'text'
    }

    try {
      await this.client.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: msgType, content },
      })
    } catch (err: unknown) {
      if (isLarkEditExpiredError(err)) return
      throw err
    }
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: InlineButton[],
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    if (!this.client) throw new Error('Lark adapter is not connected')
    if (buttons.length > LARK_MAX_BUTTONS) {
      this.log.warn('[lark] too many buttons; truncating to cap', {
        event: 'lark_button_cap',
        requested: buttons.length,
        cap: LARK_MAX_BUTTONS,
      })
    }

    // 发送卡片时按钮 value 里先不带 messageId——create 之后才知道 messageId。
    // 分两步修正：
    // 1) 用占位符发卡片；2) 取回返回的 message_id，用真实值 patch 卡片。
    // Phase 2 的可用度已经够用——点击 handler 必要时可以只靠 chat_id 查 binding，
    // 但存上 id 能让门控路由更简单。
    const placeholderCard = buildLarkCard(text, buttons, { messageId: 'pending' })
    const cardJson = JSON.stringify(placeholderCard)

    // 包裹这个 API 调用，让任何 payload 形状 / 权限 / 配额问题都以结构化的
    // `lark_send_card_failed` 事件出现在我们的日志里，而不是无标注地冒泡到
    // renderer 的外层 catch。同时在富卡片路径失败时发一条纯文本兜底，
    // 保证用户在聊天里至少看到*点什么*，然后再 re-throw 让 renderer 记录失败。
    let messageId = ''
    try {
      const result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: channelId,
          msg_type: 'interactive',
          content: cardJson,
        },
      })
      messageId = result?.data?.message_id ?? ''
      this.log.info('[lark] sent card', {
        event: 'lark_send_card_ok',
        chatId: channelId,
        messageId,
        buttonCount: Math.min(buttons.length, LARK_MAX_BUTTONS),
      })
    } catch (err: unknown) {
      // SDK 把每个错误都包成 axios 的 `AxiosError`。真正的 Lark 侧原因
      //（code + msg）在 `err.response.data` 里，不在顶层——提取出来，
      // 日志才有用。
      const errObj = (err ?? {}) as {
        code?: unknown
        msg?: unknown
        message?: unknown
        response?: { status?: unknown; data?: unknown }
      }
      const responseData = (errObj.response?.data ?? null) as
        | { code?: unknown; msg?: unknown; error?: unknown }
        | null
      this.log.error('[lark] failed to send card', {
        event: 'lark_send_card_failed',
        chatId: channelId,
        httpStatus: typeof errObj.response?.status === 'number' ? errObj.response.status : undefined,
        larkCode:
          typeof responseData?.code === 'number'
            ? responseData.code
            : typeof errObj.code === 'number'
              ? errObj.code
              : undefined,
        larkMsg:
          typeof responseData?.msg === 'string'
            ? responseData.msg
            : typeof errObj.msg === 'string'
              ? errObj.msg
              : undefined,
        larkError: responseData?.error,
        error: err instanceof Error ? err.message : String(err),
        payloadSize: cardJson.length,
        payloadPreview: cardJson.slice(0, 500),
        buttonCount: buttons.length,
      })
      // 尽力发一条纯文本兜底，让用户知道发生了什么。
      // 这里的失败是非致命的——我们仍然会重新抛出原始的卡片错误。
      try {
        await this.sendText(
          channelId,
          `${text}\n\n(Open the desktop app to respond — the in-chat buttons couldn't be sent.)`,
          _opts,
        )
      } catch {
        // 吞掉 —— renderer 的外层 handler 会看到原始的 throw。
      }
      throw err
    }

    if (messageId) {
      this.sentMsgTypes.set(messageId, 'interactive')
      // 用真实的 message_id 烤进每个按钮的 value 再 patch，
      // 让卡片点击事件带上正确的关联 id。
      try {
        const realCard = buildLarkCard(text, buttons, { messageId })
        await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(realCard) },
        })
      } catch (err: unknown) {
        // 非致命 —— 卡片已带占位 id 存在；点击路由会回退到按 chat_id 查找。
        if (!isLarkEditExpiredError(err)) {
          this.log.warn('[lark] failed to patch card with real messageId', {
            event: 'lark_card_patch_failed',
            messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    return { platform: 'lark', channelId, messageId }
  }

  async clearButtons(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    if (!this.client) return
    void channelId
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(buildClearedCard('')) },
      })
    } catch (err: unknown) {
      if (isLarkEditExpiredError(err)) return
      this.log.warn('[lark] clearButtons failed', {
        event: 'lark_clear_buttons_failed',
        messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // Lark 没有「正在输入」指示器 API。空操作。
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    if (!this.client) throw new Error('Lark adapter is not connected')

    const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(filename)

    let content: string
    let msgType: 'image' | 'file'
    if (isImage) {
      const upload = await this.client.im.image.create({
        data: { image_type: 'message', image: file },
      })
      const imageKey = upload?.image_key
      if (!imageKey) throw new Error('Lark image upload returned no image_key')
      content = JSON.stringify({ image_key: imageKey })
      msgType = 'image'
    } else {
      const upload = await this.client.im.file.create({
        data: { file_type: 'stream', file_name: filename, file: file },
      })
      const fileKey = upload?.file_key
      if (!fileKey) throw new Error('Lark file upload returned no file_key')
      content = JSON.stringify({ file_key: fileKey, file_name: filename })
      msgType = 'file'
    }

    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: channelId, msg_type: msgType, content },
    })
    const messageId = result?.data?.message_id ?? ''

    // Lark 无法在一条消息里同时带 caption + 文件。如果调用方要 caption，
    // 就作为后续文本消息发送（尽力而为）。
    if (caption) {
      this.sendText(channelId, caption).catch((err) => {
        this.log.warn('[lark] caption follow-up failed', {
          event: 'lark_caption_failed',
          messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    return { platform: 'lark', channelId, messageId }
  }

  // -------------------------------------------------------------------------
  // 入站 —— 消息 + 卡片事件
  // -------------------------------------------------------------------------

  private async handleIncomingMessage(data: LarkMessageEvent): Promise<void> {
    if (!this.messageHandler) return
    const { sender, message } = data

    // 可见性日志：如果这条从不触发，说明机器人没从 Lark 收到事件。
    // 最常见原因：缺少 `im:message` 权限、缺少事件订阅、或 App 未发布。
    this.log.info('[lark] event received', {
      event: 'lark_event_received',
      messageType: message.message_type,
      chatType: message.chat_type,
      chatId: message.chat_id,
      messageId: message.message_id,
    })

    const senderId =
      sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? ''

    // Phase 2：支持 text + image + file。其他类型（音频/视频/贴纸等）
    // 会被丢弃并打一条 info 日志，让用户知道机器人收到了事件但无法处理。
    if (message.message_type === 'text') {
      let text: string
      try {
        const parsed = JSON.parse(message.content) as { text?: string }
        text = parsed.text ?? ''
      } catch {
        text = ''
      }
      const cleaned = stripMentionPrefix(text)
      const msg: IncomingMessage = {
        platform: 'lark',
        channelId: message.chat_id,
        messageId: message.message_id,
        senderId,
        text: cleaned,
        timestamp: parseInt(message.create_time, 10) || Date.now(),
        raw: message,
      }
      await this.messageHandler(msg)
      return
    }

    if (message.message_type === 'image' || message.message_type === 'file') {
      await this.handleAttachmentMessage(data)
      return
    }

    // 未处理的类型 —— 记日志并丢弃。
    this.log.info('[lark] dropped unsupported message type', {
      event: 'lark_unsupported_msg_type',
      messageType: message.message_type,
      messageId: message.message_id,
      chatId: message.chat_id,
    })
  }

  private async handleAttachmentMessage(data: LarkMessageEvent): Promise<void> {
    if (!this.client || !this.messageHandler) return
    const { sender, message } = data
    const senderId =
      sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? ''

    let parsedContent: { image_key?: string; file_key?: string; file_name?: string }
    try {
      parsedContent = JSON.parse(message.content)
    } catch {
      this.log.warn('[lark] could not parse attachment content', {
        event: 'lark_attachment_parse_failed',
        messageId: message.message_id,
      })
      return
    }

    const isImage = message.message_type === 'image'
    const fileKey = isImage ? parsedContent.image_key : parsedContent.file_key
    if (!fileKey) {
      this.log.warn('[lark] attachment missing key', {
        event: 'lark_attachment_no_key',
        messageId: message.message_id,
      })
      return
    }
    const fallbackName = isImage
      ? `image-${randomBytes(4).toString('hex')}.jpg`
      : parsedContent.file_name ?? `file-${randomBytes(4).toString('hex')}.bin`

    const localPath = await this.downloadResource({
      messageId: message.message_id,
      fileKey,
      filename: fallbackName,
      isImage,
    })
    if (!localPath) return

    const incomingAttachment: IncomingAttachment = {
      type: isImage ? 'photo' : 'document',
      fileId: fileKey,
      fileName: fallbackName,
      localPath,
    }
    const msg: IncomingMessage = {
      platform: 'lark',
      channelId: message.chat_id,
      messageId: message.message_id,
      senderId,
      text: '',
      attachments: [incomingAttachment],
      timestamp: parseInt(message.create_time, 10) || Date.now(),
      raw: message,
    }
    await this.messageHandler(msg)
  }

  /**
   * 把一个 Lark 资源（图片或文件）下载到本地临时路径。
   *
   * Lark 资源 URL 需要 bearer-token 鉴权；我们没法把 URL 直接交给 router。
   * 改为把二进制流到临时文件，输出 `localPath`，与 Telegram 的做法一致。
   */
  private async downloadResource(args: {
    messageId: string
    fileKey: string
    filename: string
    isImage: boolean
  }): Promise<string | null> {
    if (!this.client) return null
    try {
      // SDK 的 `im.message.resource.get` 返回一个类 Node stream 对象，
      // 常见情况下带 `writeFile` 辅助方法。我们用它，省代码也省体积。
      const sdkResource = await (
        (this.client as unknown as {
          im: {
            message: {
              resource: {
                get: (args: {
                  path: { message_id: string; file_key: string }
                  params: { type: 'image' | 'file' }
                }) => Promise<{ writeFile: (path: string) => Promise<void> } & Record<string, unknown>>
              }
            }
          }
        }).im.message.resource.get
      )({
        path: { message_id: args.messageId, file_key: args.fileKey },
        params: { type: args.isImage ? 'image' : 'file' },
      })

      const ext = extname(args.filename) || (args.isImage ? '.jpg' : '.bin')
      const localPath = join(tmpdir(), `lark-${randomBytes(8).toString('hex')}${ext}`)
      // 不同 SDK 版本会暴露 `writeFile`、`file`（Buffer）或纯 Node Readable。
      // 处理常见几种形状。
      if (typeof sdkResource.writeFile === 'function') {
        await sdkResource.writeFile(localPath)
      } else if (sdkResource.file instanceof Buffer) {
        const buf = sdkResource.file
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
        }
        writeFileSync(localPath, buf)
      } else {
        throw new Error('Lark resource SDK returned an unsupported shape')
      }
      return localPath
    } catch (err: unknown) {
      this.log.warn('[lark] resource download failed', {
        event: 'lark_resource_download_failed',
        messageId: args.messageId,
        fileKey: args.fileKey,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  private async handleCardAction(data: LarkCardActionEvent): Promise<void> {
    // 可见性日志：如果用户点按钮时这条从不触发，缺失的在 Lark 开放平台侧——
    // schema 2.0 卡片只有在 App 于「事件与回调」下开启了
    // **Card Callback Communication** 订阅时才会发出 `card.action.trigger` 事件
    //（与 `im.message.receive_v1` 是分开的）。
    const channelId = data.context?.open_chat_id ?? data.open_chat_id ?? ''
    this.log.info('[lark] card action received', {
      event: 'lark_card_action_received',
      chatId: channelId,
      tag: data.action?.tag,
      hasValue: data.action?.value !== undefined,
    })

    if (!this.buttonHandler) return
    const value = data.action?.value as
      | { buttonId?: string; messageId?: string; data?: string }
      | undefined
    if (!value?.buttonId || !value?.messageId) {
      this.log.warn('[lark] card action missing correlation ids', {
        event: 'lark_card_action_no_ids',
        operator: data.operator,
      })
      return
    }
    const operator = data.operator
    const senderId = operator?.user_id ?? operator?.open_id ?? operator?.union_id ?? ''

    const press: ButtonPress = {
      platform: 'lark',
      channelId,
      messageId: value.messageId,
      buttonId: value.buttonId,
      senderId,
      ...(value.data !== undefined ? { data: value.data } : {}),
    }
    await this.buttonHandler(press)
  }
}
