/**
 * messaging gateway 的核心类型。
 *
 * workspace 作用域的 binding、平台 adapter 接口、runtime 状态，
 * 以及 messaging 栈的日志契约。
 */

// ---------------------------------------------------------------------------
// 平台类型
// ---------------------------------------------------------------------------

export type PlatformType = 'telegram' | 'whatsapp' | 'lark'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface MessagingLogContext {
  component?: string
  workspaceId?: string
  sessionId?: string
  platform?: string
  channelId?: string
  bindingId?: string
  event?: string
}

export type MessagingLogMeta = Record<string, unknown>

/**
 * messaging 栈使用的结构化 logger。
 *
 * 实现应写出结构化日志，并保留通过 `child(...)` 添加的上下文字段。
 */
export interface MessagingLogger {
  info(message: string, meta?: MessagingLogMeta): void
  warn(message: string, meta?: MessagingLogMeta): void
  error(message: string, meta?: MessagingLogMeta): void
  child(context: MessagingLogContext): MessagingLogger
}

// ---------------------------------------------------------------------------
// 运行时平台状态
// ---------------------------------------------------------------------------

export type MessagingPlatformRuntimeState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnect_required'
  | 'error'

export interface MessagingPlatformRuntimeInfo {
  platform: PlatformType
  configured: boolean
  connected: boolean
  state: MessagingPlatformRuntimeState
  identity?: string
  lastError?: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// adapter 能力
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  messageEditing: boolean
  inlineButtons: boolean
  maxButtons: number
  maxMessageLength: number
  markdown: 'v2' | 'whatsapp' | 'lark-post'
  webhookSupport: boolean
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export interface IncomingMessage {
  platform: PlatformType
  channelId: string
  /**
   * Telegram 超级群论坛话题 id（`message_thread_id`）。对 DM、General 话题
   * 以及非论坛聊天为 undefined。只有 Telegram 会填这个。
   */
  threadId?: number
  messageId: string
  senderId: string
  senderName?: string
  /**
   * 用户设置过的平台原生 username。Telegram 通过 `from.username` 提供；
   * WhatsApp/Lark 可能不填。access-control 层用它让 Settings UI 里的
   *「Pending requests」行显示得更友好，不必逼着运营者读原始 user_id。
   */
  senderUsername?: string
  /**
   * 当平台把发送方标记为 bot（Telegram `from.is_bot`）时为 `true`。
   * adapter 用它在到达 router 之前静默丢弃 bot↔bot 流量；
   * 出现在 `IncomingMessage` 里便于 access-control 审计。
   */
  senderIsBot?: boolean
  text: string
  attachments?: IncomingAttachment[]
  replyToMessageId?: string
  timestamp: number
  raw: unknown
}

export interface IncomingAttachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'audio'
  fileId: string
  fileName?: string
  mimeType?: string
  fileSize?: number
  /**
   * adapter 已把二进制下载到的本地磁盘绝对路径。设置后，router 会用
   * `readFileAttachment()` 包装它，并作为 `FileAttachment` 转发给 session。
   * 发出附件的 adapter 必须填这个 —— 没有 `localPath` 的附件会被 router 丢弃。
   */
  localPath?: string
}

export interface SentMessage {
  platform: PlatformType
  channelId: string
  messageId: string
}

export interface InlineButton {
  id: string
  label: string
  data?: string
}

export interface ButtonPress {
  platform: PlatformType
  channelId: string
  /** 按钮所依附消息的论坛话题 id（Telegram）。 */
  threadId?: number
  messageId: string
  senderId: string
  /** 可选的发送方显示名（Telegram first name）。用于 UI / pending 列表。 */
  senderName?: string
  /** 可选的发送方 username（Telegram @username，不带 `@`）。用于 UI / pending 列表。 */
  senderUsername?: string
  /** 平台把发送方标记为 bot 时为 true。access-control 会静默丢弃这些。 */
  senderIsBot?: boolean
  buttonId: string
  data?: string
}

/**
 * 出站 adapter 操作的每次调用选项。目前只有 Telegram 用 `threadId`
 *（发到论坛话题）；其他 adapter 忽略多余字段。
 */
export interface SendOptions {
  /** 要发到哪个 Telegram 论坛话题。undefined → DM 或 General 话题。 */
  threadId?: number
}

// ---------------------------------------------------------------------------
// adapter 接口
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  token?: string
  webhookUrl?: string
  webhookSecretToken?: string
  /**
   * 仅 Telegram：已配置的超级群 chatId。设置后 adapter 接收该聊天的消息
   *（在 DM 之外）；未设置时 adapter 维持仅 DM 的旧行为。
   */
  acceptedSupergroupChatId?: string
  /** 可选 logger，用于 adapter 级别诊断。 */
  logger?: MessagingLogger
  [key: string]: unknown
}

export interface PlatformAdapter {
  readonly platform: PlatformType
  readonly capabilities: AdapterCapabilities

  initialize(config: PlatformConfig): Promise<void>
  destroy(): Promise<void>
  isConnected(): boolean

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void

  sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage>
  editMessage(channelId: string, messageId: string, text: string, opts?: SendOptions): Promise<void>
  sendButtons(channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage>
  sendTyping(channelId: string, opts?: SendOptions): Promise<void>
  sendFile(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage>

  /**
   * 清除之前已发送消息上的 inline keyboard。可选，因为只有支持内联按钮的
   * 平台（目前是 Telegram）才需要。错误由调用方负责 ——
   * 大多数实现应吞掉「message can't be edited」，因为它非致命。
   */
  clearButtons?(channelId: string, messageId: string, opts?: SendOptions): Promise<void>

  /**
   * 在运行时更新 adapter 接收入站消息的聊天集合，无需重启轮询循环。
   * Telegram 用它在用户于 Settings 里配对/取消配对超级群 chatId 后
   * 进行授权/取消授权。没有可配置过滤器的 adapter 可以实现为 no-op。
   */
  setAcceptedSupergroupChatId?(chatId: string | undefined): void

  /**
   * 仅 Telegram：在超级群里创建一个新的论坛话题。用于按 session
   * 自动生成话题的 automation 集成。其他平台抛错或省略该方法。
   */
  createForumTopic?(chatId: string, name: string): Promise<{ threadId: number; name: string }>

  /** headless server 的 webhook handler（仅 Telegram）。 */
  handleWebhook?(request: Request): Promise<Response>
}

// ---------------------------------------------------------------------------
// channel binding
// ---------------------------------------------------------------------------

/**
 * agent 输出如何渲染到聊天。
 *
 * - `streaming` —— legacy 行为：最终 turn 期间做实时编辑，
 *   且每次中间态 `text_complete` 都开一条新消息。一次 agent 运行产出多条消息。
 *   保留是为了与 app 内 UI 对齐。
 * - `progress` —— 每次运行一条不断演进的消息。首次活动时发「💭 thinking…」
 *   气泡，工具运行时编辑它，`complete` 时用最终回答替换。
 *   中间态 assistant 文本被丢弃。新 binding 的默认值。
 * - `final_only` —— 直到 `complete` 才发声，然后发一条带最终文本的消息。
 *   运行没有最终文本时不发任何东西。
 */
export type ResponseMode = 'streaming' | 'progress' | 'final_only'

/**
 * 每个 binding 的 access 策略。
 *
 * - `inherit`     —— 交给平台的 owners 列表（新 binding 的默认值）。
 * - `allow-list`  —— 只有 `allowedSenderIds` 中的发送方可路由到绑定的 session。
 * - `open`        —— 受接受聊天里的任何人都可路由。作为 access control 出现前
 *                   创建的 binding 的迁移默认值，也用于显式公开的 binding
 *                  （如客服 bot）。
 */
export type BindingAccessMode = 'inherit' | 'allow-list' | 'open'

export interface BindingConfig {
  /** 出站 agent 输出如何渲染。默认：'progress' */
  responseMode: ResponseMode
  /**
   * @deprecated 改用 `responseMode`。保留是为了让旧版本写的持久化配置
   * 仍能通过校验；当 `responseMode` 存在时 renderer 会忽略此字段。
   */
  streamResponses: boolean
  /** 是否显示紧凑的工具活动摘要。默认：false */
  showToolActivity: boolean
  /** 审批发生在*哪里*（不是是否审批 —— session mode 才是权威）。 */
  approvalChannel: 'chat' | 'app'
  /** Telegram 编辑间隔，单位 ms。约 3500ms 可控制在 20 次/分钟 以下。 */
  editIntervalMs: number
  /**
   * 每个 binding 的 access 模式。仅约束 Router.route() 对本 binding 的准入。
   * 默认值因迁移 vs. 新建而异：
   *  - 新建的 binding（access control 上线后创建）：`'inherit'`。
   *  - 迁移的 binding（未设置该字段的旧数据）：`'open'`，这样生产行为在
   *    owner 显式锁定前保持不变。
   */
  accessMode: BindingAccessMode
  /**
   * 当 `accessMode === 'allow-list'` 时允许路由进本 binding 的发送方 id。
   * 其他模式下被忽略。列表是平台原生的（Telegram 数字 user_id 作为字符串）。
   */
  allowedSenderIds: string[]
}

export const DEFAULT_BINDING_CONFIG: BindingConfig = {
  responseMode: 'progress',
  streamResponses: true,
  showToolActivity: false,
  approvalChannel: 'chat',
  editIntervalMs: 3500,
  accessMode: 'inherit',
  allowedSenderIds: [],
}

export function getDefaultBindingConfig(platform: PlatformType): BindingConfig {
  return {
    ...DEFAULT_BINDING_CONFIG,
    approvalChannel: platform === 'whatsapp' ? 'app' : DEFAULT_BINDING_CONFIG.approvalChannel,
  }
}

export function normalizeBindingConfig(
  platform: PlatformType,
  config?: Partial<BindingConfig>,
): BindingConfig {
  const base = getDefaultBindingConfig(platform)
  const resolvedResponseMode: ResponseMode =
    config?.responseMode ??
    (config?.streamResponses === false ? 'final_only' : config?.streamResponses === true ? 'streaming' : base.responseMode)

  // 迁移规则：如果某个持久化配置早于 access control（没有 `accessMode` 字段），
  // 把该 binding 当作 `'open'`，这样生产行为不会悄悄变化。owner 通过 Settings 显式锁定。
  const accessMode: BindingAccessMode =
    config?.accessMode ?? (config !== undefined ? 'open' : base.accessMode)

  const allowedSenderIds = Array.isArray(config?.allowedSenderIds)
    ? [...config!.allowedSenderIds]
    : []

  return {
    ...base,
    ...config,
    responseMode: resolvedResponseMode,
    approvalChannel: platform === 'whatsapp' ? 'app' : (config?.approvalChannel ?? base.approvalChannel),
    accessMode,
    allowedSenderIds,
  }
}

export interface ChannelBinding {
  id: string
  workspaceId: string
  sessionId: string
  platform: PlatformType
  channelId: string
  /**
   * Telegram 超级群论坛话题 id。undefined = DM、General 话题或非 Telegram。
   * `bind()` 时的踢出以 `(platform, channelId, threadId ?? null)` 为键，
   * 所以 DM 和同一超级群里的话题可以独立绑定。
   */
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
  config: BindingConfig
}

// ---------------------------------------------------------------------------
// gateway 配置（按 workspace 持久化）
// ---------------------------------------------------------------------------

/**
 * workspace 级别的 Telegram 超级群（「forum」）配置。设置后，
 * adapter 接收该聊天的消息（在 DM 之外），session 可以绑定到其中特定话题。
 *
 * 通过在超级群里输入 `/pair <code>`（配 workspace-supergroup 类型的配对码）
 * 捕获。机器人用 `getChat()` 读取一次聊天标题，存储仅供显示。
 */
export interface TelegramSupergroupConfig {
  /** 超级群的 Telegram chat_id，如 `"-1001234567890"`。 */
  chatId: string
  /** 配对时捕获的显示标题。下次成功连接时刷新。 */
  title: string
  /** 配对该超级群时的 Unix-ms 时间戳。 */
  capturedAt: number
}

/**
 * messaging 平台的 workspace 级别 access 策略。
 *
 * - `open`        —— 受接受聊天里的任何人都能执行 pre-binding 命令
 *                   （`/new`、`/bind`），已绑定的聊天在路由时回退到各自的
 *                   `BindingConfig.accessMode`。
 * - `owner-only`  —— pre-binding 命令要求发送方在平台的 `owners` 列表里。
 *                   `accessMode` 为 `'inherit'` 的 binding 用同一份列表作为 allow-list。
 *
 * 默认值因迁移 vs. 新建而异：
 *  - 首次配对机器人的全新 workspace → `'owner-only'`。
 *  - 早于 access control 的已有 workspace → `'open'`，这样 Settings UI 可以
 *    显示「Lock down」banner，而不打断流量。
 */
export type PlatformAccessMode = 'open' | 'owner-only'

/**
 * 一个被授权与该 workspace 机器人交互的用户。平台原生 `userId`
 *（Telegram 数字 user_id 作为字符串）。`displayName` 和 `username`
 * 是用户配对或发消息时尽力捕获的元数据，仅供 UI 渲染。
 */
export interface PlatformOwner {
  userId: string
  displayName?: string
  username?: string
  /** 该 owner 被加入列表的 Unix-ms 时间戳。 */
  addedAt: number
}

/**
 * 发送方为何进入 pending 列表。驱动 UI 的「Allow」按钮：
 * 提升 workspace 级拒绝与提升 binding-allow-list 级拒绝是两回事，
 * 把二者悄悄混为一谈曾是一个真实的权限提升隐患。
 *
 * - `not-owner` —— workspace 级 pre-binding 拒绝。允许意味着
 *   把发送方加入 `platforms.{platform}.owners`。
 * - `not-on-binding-allowlist` —— binding 级拒绝。允许意味着
 *   把发送方追加到该 binding 的 `allowedSenderIds`，不动 workspace owners。
 */
export type PendingRejectReason = 'not-owner' | 'not-on-binding-allowlist'

/**
 * gateway 最近拒绝的发送方。在 Settings UI 里呈现，让运营者一键提升，
 * 而不必手敲数字 id。
 *
 * 该存储有界（LRU + TTL）—— 见 `pending-senders.ts`。持久化尽力而为：
 * 丢文件只是意味着运营者要等用户再次尝试访问。
 *
 * 同一个 `(platform, userId)` 在命中*不同* binding 时可以出现多次 ——
 * 运营者需要分别看到（并决定）每个 binding 级拒绝，
 * 而不是让后一条悄悄覆盖前一条。
 */
export interface PendingSender {
  /** 平台身份。 */
  platform: PlatformType
  userId: string
  displayName?: string
  username?: string
  /** 最近一次被拒尝试的 Unix-ms。 */
  lastAttemptAt: number
  /** 自该发送方首次出现在 pending 列表以来的总尝试次数。 */
  attemptCount: number
  /**
   * 发送方被拒的原因。可选，用于与缺少该字段的旧构建写入的持久化条目
   * 向后兼容；缺失 `reason` 时按 `'not-owner'`（更安全的默认）处理。
   */
  reason?: PendingRejectReason
  /**
   * 拒绝所作用域的 binding。仅在 `reason === 'not-on-binding-allowlist'`
   * 时存在。让运营者的「Allow」操作能定位到正确 binding 的 `allowedSenderIds`。
   */
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

export interface MessagingConfig {
  enabled: boolean
  platforms: {
    telegram?: {
      enabled: boolean
      /**
       * 可选的已配置超级群。adapter 除 DM 外也接收该聊天的消息。
       * session 可以绑定到其中特定话题。
       */
      supergroup?: TelegramSupergroupConfig
      /**
       * workspace 级别的 access 策略。字段缺失 = `'open'`，
       * 用于与早于 access control 的 workspace 向后兼容。全新配置会自动落到
       * `'owner-only'`（registry 在首次配对时设置）。
       */
      accessMode?: PlatformAccessMode
      /**
       * 允许在 workspace 级别驱动机器人的 Telegram 用户 id。
       * 门控 `/new`、`/bind`、`/unbind`、`/status`、`/stop`，
       * 并作为 `accessMode === 'inherit'` 的 binding 的默认发送方 allow-list。
       *
       * `/pair` 本身保持开放：列表为空时，第一次成功消费会把消费的发送方
       * 种子进列表。此后只有现有 owner 才能继续消费配对码。
       */
      owners?: PlatformOwner[]
    }
    whatsapp?: {
      enabled: boolean
      /**
       * 为 true 时，同一 WA 账号的其他设备发到 self-JID（你自己的号码）的消息
       * 会被路由到绑定的 session。worker 通过 sent-ID 跟踪 + response prefix
       * 过滤自己的回显。未设置时默认为 `true` —— 对新用户而言，
       *「不用第二个手机号」的流程才是预期 UX。
       */
      selfChatMode?: boolean
    }
    lark?: {
      enabled: boolean
      /**
       * 该机器人属于哪个 Lark/飞书域名。一个机器人注册在一个开放平台下 ——
       * 尽管共用同一套 SDK + 协议，它们是相互独立的生态。
       *  - `lark` → open.larksuite.com（国际版）
       *  - `feishu` → open.feishu.cn（中国）
       */
      domain?: 'lark' | 'feishu'
    }
  }
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  enabled: false,
  platforms: {},
}
