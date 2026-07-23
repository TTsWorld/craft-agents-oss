/**
 * 主进程（WhatsAppAdapter）与 WhatsApp worker 子进程之间的 IPC 协议。
 *
 * 传输方式：通过 worker 的 stdin/stdout 传递换行分隔的 JSON（NDJSON）。
 * - 主进程 → Worker：每行一条 WorkerCommand（经 stdin）。
 * - Worker → 主进程：每行一条 WorkerEvent（经 stdout）。
 * - Worker 的 stderr 保留给自由格式的日志（不做解析）。
 *
 * 协议刻意保持精简——worker 持有所有 Baileys 状态；
 * 主进程只负责驱动生命周期并转发收发消息。
 */

// ---------------------------------------------------------------------------
// 命令（主进程 → worker）
// ---------------------------------------------------------------------------

export type WorkerCommand =
  | StartCommand
  | SubmitPairingPhoneCommand
  | SendTextCommand
  | SendFileCommand
  | ShutdownCommand

export interface StartCommand {
  type: 'start'
  /** 持久化 Baileys 多文件认证状态的绝对路径。 */
  authStateDir: string
  /** 可选：使用配对码模式而非二维码模式。 */
  pairingMode?: 'qr' | 'code'
  /**
   * 为 true 时，本账号在其他设备上发往 self-JID（用户自己的号码）的消息
   * 会被当作用户输入处理。默认 `false`（保持原有的丢弃所有 `fromMe` 流量的行为）。
   *
   * Worker 用两种方式过滤自己的回声：一是追踪自己发送过的 ID，
   * 二是在消息文本里检查 `responsePrefix`。
   */
  selfChatMode?: boolean
  /**
   * 自聊模式开启且通道为 self-JID 时，追加到出站消息前的前缀。
   * 既用于在自聊会话里做视觉区分，也是在 worker 重启导致 sent-ID 追踪集合丢失时
   * 的稳健回声过滤器。自聊开启时默认为 🤖。为空或缺省 → 回退到默认值。
   */
  responsePrefix?: string
}

export interface SubmitPairingPhoneCommand {
  type: 'submit_pairing_phone'
  /** E.164 格式，纯数字（Baileys 接受不带 '+' 的号码）。 */
  phoneNumber: string
}

export interface SendTextCommand {
  id: string
  type: 'send_text'
  channelId: string
  text: string
}

export interface SendFileCommand {
  id: string
  type: 'send_file'
  channelId: string
  /** Base64 编码的文件字节。 */
  dataBase64: string
  filename: string
  caption?: string
  mimeType?: string
}

export interface ShutdownCommand {
  type: 'shutdown'
}

// ---------------------------------------------------------------------------
// 事件（worker → 主进程）
// ---------------------------------------------------------------------------

export type WorkerEvent =
  | ReadyEvent
  | QrEvent
  | PairingCodeEvent
  | ConnectedEvent
  | DisconnectedEvent
  | IncomingEvent
  | SendResultEvent
  | ErrorEvent
  | UnavailableEvent

export interface ReadyEvent {
  type: 'ready'
  /** Worker 上报的 Baileys 版本，仅供参考。 */
  baileysVersion?: string
  /** worker bundle 构建产物的 ISO 时间戳，仅供参考。 */
  buildId?: string
  /** bundle 构建来源的 git 短 SHA（或 `unknown`/`dev-unbundled`）。 */
  gitSha?: string
}

export interface QrEvent {
  type: 'qr'
  /** Baileys 原始 QR 字符串（在 UI 侧再编码成二维码）。 */
  qr: string
}

export interface PairingCodeEvent {
  type: 'pairing_code'
  code: string
}

export interface ConnectedEvent {
  type: 'connected'
  jid?: string
  name?: string
}

export interface DisconnectedEvent {
  type: 'disconnected'
  /** 会话被永久丢失（被登出、被封禁）时为 `true`。 */
  loggedOut: boolean
  reason?: string
}

/**
 * 通过线路传输的媒体附件。Worker 下载字节、写入临时文件，
 * 并上报绝对路径。主进程侧的适配器会把它转换成 gateway 的 `IncomingAttachment`。
 */
export interface WorkerIncomingAttachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'audio'
  fileName?: string
  mimeType?: string
  fileSize?: number
  /** worker 写入媒体的临时文件绝对路径。 */
  localPath: string
}

export interface IncomingEvent {
  type: 'incoming'
  channelId: string
  messageId: string
  senderId: string
  senderName?: string
  text: string
  attachments?: WorkerIncomingAttachment[]
  timestamp: number
}

export interface SendResultEvent {
  type: 'send_result'
  /** 与 SendTextCommand/SendFileCommand 的 `id` 关联。 */
  id: string
  ok: boolean
  messageId?: string
  error?: string
}

export interface ErrorEvent {
  type: 'error'
  /** 非致命——worker 仍在运行。 */
  message: string
}

export interface UnavailableEvent {
  type: 'unavailable'
  /**
   * 致命错误——worker 无法继续（可能发生在启动阶段或连接后）。
   *
   * `reason`：
   * - `baileys_load_failed`   — 打包进来的 Baileys 在初始化时抛错（罕见）
   * - `auth_state_error`      — 读写认证状态目录失败
   * - `reconnect_exhausted`   — 反复非登出关闭达到重试上限
   * - `unknown`               — 查看 `message`
   */
  reason: 'baileys_load_failed' | 'auth_state_error' | 'reconnect_exhausted' | 'unknown'
  message: string
}

// ---------------------------------------------------------------------------
// NDJSON 辅助函数
// ---------------------------------------------------------------------------

export function encodeMessage(msg: WorkerCommand | WorkerEvent): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * 增量解析换行分隔的 JSON 流。返回解析出的消息以及留给下一个数据块的未解析尾部。
 */
export function parseFrames<T>(buffer: string): { messages: T[]; rest: string } {
  const messages: T[] = []
  let rest = buffer
  while (true) {
    const nl = rest.indexOf('\n')
    if (nl === -1) break
    const line = rest.slice(0, nl).trim()
    rest = rest.slice(nl + 1)
    if (!line) continue
    try {
      messages.push(JSON.parse(line) as T)
    } catch {
      // 跳过格式错误的行——worker stderr 泄漏虽然已被过滤，
      // 但仍然防御性处理，避免单行坏数据导致整个流挂掉。
    }
  }
  return { messages, rest }
}
