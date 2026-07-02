/**
 * 文件：messaging-registry-interface.ts
 * 位置：packages/server-core/src/handlers
 * 职责：定义消息网关注册表 IMessagingGatewayRegistry 及其相关数据类型。
 *
 * 架构角色：
 *   - server-core 的 RPC handler 只依赖这个接口，不直接依赖 @craft-agent/messaging-gateway。
 *   - 这样 renderer / RPC 层不需要导入 gateway 包，避免循环依赖和包体积问题。
 *   - 类似 Go 中在 handler 层定义 port（接口），由 messaging-gateway 包提供 adapter。
 *
 * Agent 开发关注点：
 *   - 消息网关允许外部 IM 平台（Telegram、WhatsApp、Lark 等）驱动 Agent 会话。
 *   - 访问控制分两层：workspace/platform 级 和 binding/session 级，防止未授权用户调用 Agent。
 */

export interface MessagingBindingInfo {
  id: string
  workspaceId: string
  sessionId: string
  platform: string
  channelId: string
  /** Telegram 超级群的话题 ID；DM 或非 Telegram 平台为 undefined。 */
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
  /**
   * 单条 binding 的访问策略。
   * 可选是为了兼容旧客户端；Phase 3 会把 renderer 也接入。
   */
  accessMode?: 'inherit' | 'allow-list' | 'open'
  allowedSenderIds?: string[]
}

/**
 * Workspace 级别的 Telegram 超级群配置。
 * 通过 `/pair <code>` 流程绑定；通过 unbindWorkspaceSupergroup 解绑。
 */
export interface MessagingSupergroupInfo {
  chatId: string
  title: string
  capturedAt: number
}

export interface MessagingPlatformRuntimeInfo {
  platform: string
  configured: boolean
  connected: boolean
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error'
  identity?: string
  lastError?: string
  updatedAt: number
}

/**
 * 被授权在平台级别驱动 workspace bot 的用户。
 * 与 @craft-agent/messaging-gateway 里的 PlatformOwner 镜像，避免 renderer/RPC 层直接引用 gateway。
 */
export interface MessagingPlatformOwnerInfo {
  userId: string
  displayName?: string
  username?: string
  addedAt: number
}

/**
 * 发送者进入 pending 列表的原因。
 * 用于 UI 决定“Allow”按钮文案，以及 gateway 的晋升语义。
 */
export type MessagingPendingRejectReason = 'not-owner' | 'not-on-binding-allowlist'

/**
 * 最近被 gateway 拒绝的发送者。
 * 在 Settings → Messaging 中显示为“Pending requests”。
 */
export interface MessagingPendingSenderInfo {
  platform: string
  userId: string
  displayName?: string
  username?: string
  lastAttemptAt: number
  attemptCount: number
  /**
   * 拒绝原因。可选是为了兼容早期构建写入的持久化数据。
   */
  reason?: MessagingPendingRejectReason
  /** binding 上下文（仅 'not-on-binding-allowlist' 原因有值）。 */
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

export type MessagingPlatformAccessMode = 'open' | 'owner-only'

export type MessagingBindingAccessMode = 'inherit' | 'allow-list' | 'open'

/**
 * 消息网关配置信息。
 *
 * TS 特性：
 *   - `Record<string, T | undefined>` 表示键是 string，值可能不存在，
 *     类似 Go 的 `map[string]*T`（通过 nil 表示不存在）。
 *   - platforms 的值是联合类型：普通平台只有 enabled；Telegram 还可以有 supergroup/accessMode/owners。
 */
export interface MessagingConfigInfo {
  enabled: boolean
  /**
   * 每个平台的配置。Telegram 可能有 supergroup、accessMode、owners；
   * 其他平台目前只用 enabled。
   */
  platforms: Record<
    string,
    | {
        enabled: boolean
        supergroup?: MessagingSupergroupInfo
        accessMode?: MessagingPlatformAccessMode
        owners?: MessagingPlatformOwnerInfo[]
      }
    | undefined
  >
  runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>
}

/**
 * 消息网关注册表接口。
 *
 * TS 特性：
 *   - 方法返回复杂的 discriminated union，例如 bindAutomationSession 返回
 *     `{ ok: true; ... } | { ok: false; reason: ...; error?: string }`。
 *   - 调用方通过 `if (result.ok)` 分支，类似 Go 中通过 `if err != nil` 分支，
 *     TS 编译器会自动收窄到对应分支的类型。
 */
export interface IMessagingGatewayRegistry {
  /** 获取某个 workspace 的所有 binding。 */
  getBindings(workspaceId: string): MessagingBindingInfo[]

  /** 获取某个 workspace 的配置和运行时状态。 */
  getConfig(workspaceId: string): MessagingConfigInfo | null

  /** 更新某个 workspace 的消息配置。 */
  updateConfig(workspaceId: string, config: Partial<MessagingConfigInfo>): Promise<void>

  /** 生成配对码，用于把 session 绑定到某个聊天。 */
  generatePairingCode(workspaceId: string, sessionId: string, platform: string): { code: string; expiresAt: number; botUsername?: string }

  /**
   * 生成 Telegram 超级群配对码。
   * 用户在超级群里输入配对码后，该群会被注册为 workspace 级别的超级群。
   * 目前仅 Telegram 支持，属于 topics 特性的 Phase A。
   */
  generateSupergroupPairingCode(
    workspaceId: string,
    platform: string,
  ): { code: string; expiresAt: number; botUsername?: string }

  /** 读取当前 workspace 已配对的 Telegram 超级群，若无返回 null。 */
  getWorkspaceSupergroup(workspaceId: string): MessagingSupergroupInfo | null

  /** 解绑 workspace 当前已配对的 Telegram 超级群。 */
  unbindWorkspaceSupergroup(workspaceId: string): Promise<void>

  /**
   * 把新创建的自动化 session 绑定到已配对超级群的某个话题（不存在则创建）。
   * 尽力而为，返回可辨识结果，调用方可选择记录日志后继续，不阻塞 session。
   */
  bindAutomationSession(args: {
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
  >

  /**
   * 删除本地缓存的自动化话题条目。
   * 不会真正删除 Telegram 话题本身；用于 automation 改名/移除后希望下次同名重建话题的场景。
   */
  removeAutomationTopic(workspaceId: string, topicName: string): Promise<void>

  /** 解绑某个 session 的所有 binding，可指定 platform 过滤。 */
  unbindSession(workspaceId: string, sessionId: string, platform?: string): void

  /** 根据 ID 解绑某一条 binding。 */
  unbindBinding(workspaceId: string, bindingId: string): boolean

  /** 测试 Telegram bot token 是否有效。 */
  testTelegramToken(token: string): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }>

  /** 保存 Telegram token 并（重新）初始化 adapter。 */
  saveTelegramToken(workspaceId: string, token: string): Promise<void>

  /**
   * 测试 Lark/Feishu 凭证，换取 tenant access token。
   * domain 参数决定调用哪个开放平台。
   */
  testLarkCredentials(creds: {
    appId: string
    appSecret: string
    domain: 'lark' | 'feishu'
  }): Promise<{ success: boolean; botName?: string; error?: string }>

  /** 保存 Lark/Feishu 凭证并（重新）初始化 adapter。 */
  saveLarkCredentials(workspaceId: string, creds: {
    appId: string
    appSecret: string
    domain: 'lark' | 'feishu'
  }): Promise<void>

  /** 停用某平台，保留 WhatsApp 授权状态（除非单独 forget）。 */
  disconnectPlatform(workspaceId: string, platform: string): Promise<void>

  /** 停用某平台，并在支持时清除本地授权/设备状态。 */
  forgetPlatform(workspaceId: string, platform: string): Promise<void>

  /**
   * 启动 WhatsApp 连接流程。
   * 会启动 worker，并通过 WA_UI_EVENT 发送二维码或配对码提示。
   */
  startWhatsAppConnect(workspaceId: string): Promise<void>

  /**
   * 向运行中的 WhatsApp worker 提交手机号请求配对码。
   * 必须在 startWhatsAppConnect 之后调用。
   */
  submitWhatsAppPhone(workspaceId: string, phoneNumber: string): Promise<void>

  // -------------------------------------------------------------------------
  // 访问控制（Phase 2/3）
  // -------------------------------------------------------------------------

  /** 读取平台级别的 owner 列表（workspace 作用域）。 */
  getPlatformOwners(workspaceId: string, platform: string): MessagingPlatformOwnerInfo[]

  /** 替换平台级别的 owner 列表。 */
  setPlatformOwners(
    workspaceId: string,
    platform: string,
    owners: MessagingPlatformOwnerInfo[],
  ): MessagingPlatformOwnerInfo[]

  /** 读取 workspace 的平台级访问策略。 */
  getPlatformAccessMode(workspaceId: string, platform: string): MessagingPlatformAccessMode

  /** 设置 workspace 的平台级访问策略。 */
  setPlatformAccessMode(
    workspaceId: string,
    platform: string,
    mode: MessagingPlatformAccessMode,
  ): void

  /**
   * 列出最近被拒绝的发送者。
   * 在 Settings → Messaging 显示为“Pending requests”。
   * platform 参数可选，用于过滤。
   */
  getPendingSenders(workspaceId: string, platform?: string): MessagingPendingSenderInfo[]

  /** 丢弃某个 pending 发送者，不提升权限。 */
  dismissPendingSender(workspaceId: string, platform: string, userId: string): boolean

  /**
   * 允许某个 pending 发送者。
   * 根据 entry.reason 分支：
   *   - 'not-owner' → 加入 platform owners。
   *   - 'not-on-binding-allowlist' → 加入对应 binding 的 allow-list（不动 workspace owners）。
   *
   * entryKey 让 UI 能精确定位某一行，因为同一个发送者可能在 workspace 和 binding 都有 pending。
   * 找不到记录或对应 binding 已被解绑时抛出。
   */
  allowPendingSender(
    workspaceId: string,
    platform: string,
    userId: string,
    entryKey?: { reason?: MessagingPendingRejectReason; bindingId?: string },
  ): { owners: MessagingPlatformOwnerInfo[]; bindingId?: string }

  /** 更新单条 binding 的访问策略。 */
  setBindingAccess(
    workspaceId: string,
    bindingId: string,
    access: { mode: MessagingBindingAccessMode; allowedSenderIds?: string[] },
  ): void
}
