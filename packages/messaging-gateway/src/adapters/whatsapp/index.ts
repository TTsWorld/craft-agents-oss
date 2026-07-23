/**
 * WhatsAppAdapter —— 进程外适配器，拉起
 * `@craft-agent/messaging-whatsapp-worker` 子进程。
 *
 * WhatsApp 没有我们能用的官方 bot API。Baileys 重新实现了 WA multi-device
 * 协议 —— 它跑在子进程里，目的是：
 *   (a) Baileys 的 crash/segfault 不会拖垮 Electron 主进程，
 *   (b) 即使宿主运行时是 Bun，Baileys 也能在 Node 下运行，
 *   (c) 内存隔离：auth state、signal ratchets 等。
 *
 * worker 契约定义在 @craft-agent/messaging-whatsapp-worker 里。
 * 本适配器负责进程生命周期管理，并把事件翻译为 PlatformAdapter 接口。
 *
 * 非官方 API 免责声明：Baileys 未被 WhatsApp/Meta 认可，
 * 随时可能失效。账号封禁也是有可能的。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  encodeMessage,
  parseFrames,
  type WorkerCommand,
  type WorkerEvent,
} from '@craft-agent/messaging-whatsapp-worker'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingMessage,
  IncomingAttachment,
  SendOptions,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
} from '../../types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * `sendText`/`sendFile` 等待的硬上限。如果 worker 在命令派发与
 * `send_result` 之间卡住（Baileys 死锁、无限重试、socket 停滞），
 * 我们就向调用方暴露一个真实错误，而不是让 renderer 的 `text_complete`
 * 路径无限挂起、冻结聊天。取值要从容覆盖慢网络下 Baileys 最坏往返时延；
 * 更短会让合法的发送被饿死。测试通过 `WhatsAppConfig.sendTimeoutMs`
 * 传一个更小的值。
 */
const DEFAULT_SEND_TIMEOUT_MS = 30_000

type PendingEntry = {
  resolve: (r: { ok: boolean; messageId?: string; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface WhatsAppConfig extends PlatformConfig {
  /** Baileys 持久化 multi-file auth state 的目录。必填。 */
  authStateDir: string
  /** worker 入口脚本的绝对路径。必填。 */
  workerEntry: string
  /** Node 二进制路径。默认为 'node'。 */
  nodeBin?: string
  /** 配对流程：'qr'（默认）或 'code'（基于手机号的 8 字符配对码）。 */
  pairingMode?: 'qr' | 'code'
  /**
   * 是否接受本账号其他设备（手机/WA Desktop/WA Web）在 self-chat 里发出的消息。
   * agent 回显通过 sent-ID 跟踪 + response prefix 过滤掉。具体机制见
   * `WorkerCommand.StartCommand`。
   */
  selfChatMode?: boolean
  /** 加在出站 self-chat 消息前的前缀。默认为 🤖。 */
  responsePrefix?: string
  /**
   * 覆盖默认的每次发送超时（30s）。供测试使用；不通过 registry 或 UI 暴露。
   * 更小的值能更快暴露 worker 死锁，但在慢网络下有误杀合法发送的风险。
   */
  sendTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// 事件总线（适配器级别，通过 registry 暴露）
// ---------------------------------------------------------------------------

export type WhatsAppEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }

type EventHandler = (event: WhatsAppEvent) => void

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: 4096,
    markdown: 'whatsapp',
    webhookSupport: false,
  }

  private proc: ChildProcess | null = null
  private stdoutBuffer = ''
  private connected = false
  private started = false
  private log: MessagingLogger = NOOP_LOGGER
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private eventHandlers = new Set<EventHandler>()
  private pending = new Map<string, PendingEntry>()
  private nextCmdId = 1
  private sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS

  async initialize(config: PlatformConfig): Promise<void> {
    const cfg = config as WhatsAppConfig
    if (!cfg.workerEntry) throw new Error('WhatsApp: workerEntry path is required')
    if (!cfg.authStateDir) throw new Error('WhatsApp: authStateDir is required')

    if (this.proc) {
      throw new Error('WhatsApp adapter already initialized')
    }

    this.log = (cfg.logger ?? NOOP_LOGGER).child({
      component: 'whatsapp-adapter',
      platform: 'whatsapp',
    })

    if (cfg.sendTimeoutMs !== undefined && cfg.sendTimeoutMs > 0) {
      this.sendTimeoutMs = cfg.sendTimeoutMs
    }

    const nodeBin = cfg.nodeBin ?? process.execPath
    this.log.info('starting WhatsApp worker', {
      event: 'whatsapp_worker_starting',
      workerEntry: cfg.workerEntry,
      authStateDir: cfg.authStateDir,
      pairingMode: cfg.pairingMode ?? 'qr',
      nodeBin,
    })

    this.proc = spawn(nodeBin, [cfg.workerEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk
      const { messages, rest } = parseFrames<WorkerEvent>(this.stdoutBuffer)
      this.stdoutBuffer = rest
      for (const ev of messages) this.onWorkerEvent(ev)
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        this.log.warn('WhatsApp worker stderr', {
          event: 'whatsapp_worker_stderr',
          line,
        })
      }
    })

    this.proc.on('exit', (code, signal) => {
      this.connected = false
      this.started = false
      this.proc = null
      this.drainPending(
        `worker exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
      )
      this.log.warn('WhatsApp worker exited', {
        event: 'whatsapp_worker_exited',
        code,
        signal,
      })
      if (code !== 0) {
        this.fireEvent({
          type: 'error',
          message: `Worker exited with code ${code ?? 'null'}`,
        })
      }
    })

    const startCmd: WorkerCommand = {
      type: 'start',
      authStateDir: cfg.authStateDir,
      pairingMode: cfg.pairingMode ?? 'qr',
      selfChatMode: cfg.selfChatMode ?? false,
      responsePrefix: cfg.responsePrefix,
    }
    this.sendCommand(startCmd)
    this.started = true
  }

  async destroy(): Promise<void> {
    if (!this.proc) return
    this.log.info('shutting down WhatsApp worker', { event: 'whatsapp_worker_shutdown' })
    try {
      this.sendCommand({ type: 'shutdown' })
    } catch (err) {
      this.log.warn('failed to send shutdown to WhatsApp worker', {
        event: 'whatsapp_worker_shutdown_signal_failed',
        error: err,
      })
    }
    const proc = this.proc
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, 2000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    // 防御性：`proc.on('exit')` 通常会先做 drain，但如果 exit 事件被延迟，
    // 或者在一次竞争之后才注册，上面的 promise 可能先通过 SIGKILL 定时器 resolve，
    // 此时 `exit` 还没触发。这里再 drain 一次，确保没有调用方被遗留挂起。
    this.drainPending('adapter destroyed')
    this.proc = null
    this.started = false
    this.connected = false
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

  /** 订阅适配器级别的事件（QR、配对码、unavailable、错误）。 */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** 提交手机号以获取 8 字符配对码（pairingMode=code）。 */
  async requestPairingCode(phoneNumber: string): Promise<void> {
    if (!this.started) throw new Error('WhatsApp adapter not started')
    this.log.info('requesting WhatsApp pairing code', {
      event: 'whatsapp_pairing_code_requested',
    })
    this.sendCommand({ type: 'submit_pairing_phone', phoneNumber })
  }

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    // _opts（threadId）是 Telegram 专用的；WhatsApp 上忽略。
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({ id, type: 'send_text', channelId, text })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'whatsapp',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  async editMessage(
    _channelId: string,
    _messageId: string,
    _text: string,
    _opts?: SendOptions,
  ): Promise<void> {
    throw new Error('WhatsApp edit not supported in this adapter')
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: InlineButton[],
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    const numbered = buttons
      .map((b, i) => `${i + 1}. ${b.label}`)
      .join('\n')
    const combined = numbered ? `${text}\n\n${numbered}` : text
    return this.sendText(channelId, combined)
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // 空操作 —— 省略「正在输入」的 presence 更新可以少一次穿过 worker 的往返；
    // 没有它 UX 仍然可接受。
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({
      id,
      type: 'send_file',
      channelId,
      dataBase64: file.toString('base64'),
      filename,
      caption,
    })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'whatsapp',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private sendCommand(cmd: WorkerCommand): void {
    if (!this.proc || !this.proc.stdin?.writable) {
      throw new Error('WhatsApp worker is not running')
    }
    this.proc.stdin.write(encodeMessage(cmd))
  }

  private sendWithResult(
    cmd: Extract<WorkerCommand, { id: string }>,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 如果 `send_result` 已经到达并清掉了 entry，`delete` 会返回 false；
        // 在那种竞争里我们已经 resolve 过了，不能再 resolve 一次。
        if (this.pending.delete(cmd.id)) {
          this.log.warn('WhatsApp send timed out', {
            event: 'whatsapp_send_timeout',
            commandId: cmd.id,
            commandType: cmd.type,
            timeoutMs: this.sendTimeoutMs,
          })
          resolve({ ok: false, error: `send timed out after ${this.sendTimeoutMs}ms` })
        }
      }, this.sendTimeoutMs)
      this.pending.set(cmd.id, { resolve, timer })
      try {
        this.sendCommand(cmd)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(cmd.id)
        this.log.error('failed to send command to WhatsApp worker', {
          event: 'whatsapp_worker_command_failed',
          commandType: cmd.type,
          error: err,
        })
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  /**
   * 把所有 pending 的发送以失败 resolve 掉。从 `proc.on('exit')`
   *（worker 崩溃/退出）和 `destroy()`（有序关闭）两处调用，
   * 这样调用方永远不会挂在一个不会再响应的 worker 上。
   */
  private drainPending(reason: string): void {
    if (this.pending.size === 0) return
    this.log.warn('draining pending WhatsApp sends', {
      event: 'whatsapp_pending_drain',
      count: this.pending.size,
      reason,
    })
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: reason })
    }
    this.pending.clear()
  }

  private fireEvent(event: WhatsAppEvent): void {
    for (const h of this.eventHandlers) {
      try {
        h(event)
      } catch {
        // 隔离 handler 抛出的错误
      }
    }
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case 'ready':
        this.log.info('WhatsApp worker ready', {
          event: 'whatsapp_worker_ready',
          baileysVersion: ev.baileysVersion,
          buildId: ev.buildId,
          gitSha: ev.gitSha,
        })
        return
      case 'qr':
        this.log.info('WhatsApp QR received', { event: 'whatsapp_qr_received' })
        this.fireEvent({ type: 'qr', qr: ev.qr })
        return
      case 'pairing_code':
        this.log.info('WhatsApp pairing code received', { event: 'whatsapp_pairing_code_received' })
        this.fireEvent({ type: 'pairing_code', code: ev.code })
        return
      case 'connected':
        this.connected = true
        this.log.info('WhatsApp connected', {
          event: 'whatsapp_connected',
          jid: ev.jid,
          name: ev.name,
        })
        this.fireEvent({ type: 'connected', jid: ev.jid, name: ev.name })
        return
      case 'disconnected':
        this.connected = false
        this.log.warn('WhatsApp disconnected', {
          event: 'whatsapp_disconnected',
          loggedOut: ev.loggedOut,
          reason: ev.reason,
        })
        this.fireEvent({ type: 'disconnected', loggedOut: ev.loggedOut, reason: ev.reason })
        return
      case 'incoming':
        if (this.messageHandler) {
          // WhatsApp 不像 Telegram 有独立的 file_id；这里复用 messageId 做可追溯。
          // worker 已经把字节写到了 `localPath`，所以 router 可以直接通过
          // `readFileAttachment()` 包装每个附件。
          const attachments: IncomingAttachment[] | undefined = ev.attachments?.map((a) => ({
            type: a.type,
            fileId: ev.messageId,
            fileName: a.fileName,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            localPath: a.localPath,
          }))
          const msg: IncomingMessage = {
            platform: 'whatsapp',
            channelId: ev.channelId,
            messageId: ev.messageId,
            senderId: ev.senderId,
            senderName: ev.senderName,
            text: ev.text,
            attachments,
            timestamp: ev.timestamp,
            raw: ev,
          }
          void this.messageHandler(msg)
        }
        return
      case 'send_result': {
        const entry = this.pending.get(ev.id)
        if (entry) {
          clearTimeout(entry.timer)
          this.pending.delete(ev.id)
          entry.resolve({ ok: ev.ok, messageId: ev.messageId, error: ev.error })
        }
        if (!ev.ok) {
          this.log.error('WhatsApp send failed', {
            event: 'whatsapp_send_failed',
            commandId: ev.id,
            error: ev.error,
          })
        }
        return
      }
      case 'error':
        this.log.error('WhatsApp worker reported error', {
          event: 'whatsapp_worker_error',
          error: ev.message,
        })
        this.fireEvent({ type: 'error', message: ev.message })
        return
      case 'unavailable':
        this.log.error('WhatsApp unavailable', {
          event: 'whatsapp_unavailable',
          reason: ev.reason,
          error: ev.message,
        })
        this.fireEvent({ type: 'unavailable', reason: ev.reason, message: ev.message })
        return
    }
  }
}
