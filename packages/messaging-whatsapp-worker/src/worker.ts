/**
 * WhatsApp worker 子进程入口。
 *
 * 持有所有 Baileys 状态。通过 stdin/stdout 上的换行分隔 JSON 与主进程通信
 * （见 protocol.ts）。
 *
 * Baileys 在构建时由 esbuild 打包进 worker.cjs，因此下方的动态 import 总能解析成功。
 * try/catch 作为运行时安全网保留——例如未来某个 Baileys 版本在不支持的
 * Node 运行时上初始化模块时抛错，我们希望得到一个干净的 `unavailable` 事件，
 * 而不是子进程崩溃。
 *
 * 随 Electron 打包时在 Node（而非 Bun）下运行，以保证 Baileys 的
 * 加密依赖（libsignal、curve25519）能正确解析。
 */

import { mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import {
  encodeMessage,
  parseFrames,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol'
import { bareJid, rememberSentId } from './filter'
import { processUpsertMessage } from './upsert'

/**
 * 由 `scripts/build-wa-worker.ts` 通过 esbuild `--define` 注入的构建时常量。
 * 开发时（未打包）回退到 `dev-*` 值，这样类型检查和临时运行仍然可用。
 */
declare const __WA_WORKER_BUILD_ID__: string
declare const __WA_WORKER_GIT_SHA__: string
const WORKER_BUILD_ID =
  typeof __WA_WORKER_BUILD_ID__ !== 'undefined' ? __WA_WORKER_BUILD_ID__ : 'dev-unbundled'
const WORKER_GIT_SHA =
  typeof __WA_WORKER_GIT_SHA__ !== 'undefined' ? __WA_WORKER_GIT_SHA__ : 'dev-unbundled'

// ---------------------------------------------------------------------------
// 发送辅助函数
// ---------------------------------------------------------------------------

function emit(event: WorkerEvent): void {
  process.stdout.write(encodeMessage(event))
}

function log(...args: unknown[]): void {
  // stderr 保留给日志，避免被主进程的解析器误当成协议数据。
  process.stderr.write('[wa-worker] ' + args.map(String).join(' ') + '\n')
}

// ---------------------------------------------------------------------------
// Baileys 的静默日志器
//
// Baileys 使用 pino，默认写 stdout——这会和我们的 NDJSON 协议冲突。
// 这个 no-op 日志器实现了 Baileys 实际调用的 pino API 子集，保持协议流干净。
// ---------------------------------------------------------------------------

interface SilentLogger {
  level: string
  fatal: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
  child: () => SilentLogger
}

const silentLogger: SilentLogger = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
}

// ---------------------------------------------------------------------------
// Baileys 生命周期（隔离——仅在动态 import 成功后才被引用）
// ---------------------------------------------------------------------------

export interface BaileysModule {
  /**
   * 同时以 `default` 和 `makeWASocket` 导出的工厂函数。我们优先用命名导出，
   * 因为经 esbuild `await import()` 的 CJS→ESM interop 不总是把 `.default`
   * 暴露为可调用函数。
   */
  default?: (config: unknown) => unknown
  makeWASocket: (config: unknown) => unknown
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>
  DisconnectReason: Record<string, number>
  Browsers: { macOS: (name: string) => [string, string, string] }
  fetchLatestBaileysVersion: () => Promise<{ version: number[]; isLatest: boolean }>
  /**
   * 下载媒体消息（图片 / 音频 / 视频 / 文档）。传入 `'buffer'` 时返回 Buffer。
   * 消息没有媒体载荷时抛错——调用方应先用变体 key 检查做前置判断。
   * 签名与 `@whiskeysockets/baileys@^6.7.0` 保持一致。
   */
  downloadMediaMessage: (
    message: { message?: unknown; key?: unknown },
    type: 'buffer',
    options: Record<string, unknown>,
  ) => Promise<Buffer>
}

type BaileysSock = {
  ev: {
    on(event: 'creds.update', fn: () => void): void
    on(event: 'connection.update', fn: (u: Record<string, unknown>) => void): void
    on(event: 'messages.upsert', fn: (u: { messages: unknown[]; type: string }) => void): void
  }
  user?: { id?: string; name?: string; lid?: string }
  requestPairingCode(phoneNumber: string): Promise<string>
  sendMessage(jid: string, content: unknown): Promise<{ key?: { id?: string } } | undefined>
  logout(): Promise<void>
  end(err?: Error): void
}

interface SessionState {
  baileys: BaileysModule
  sock: BaileysSock
  saveCreds: () => Promise<void>
  pairingMode: 'qr' | 'code'
  authStateDir: string
  /** 收到 `shutdown` 命令时置位，用于取消任何待处理的重连。 */
  shuttingDown: boolean
  /** 连续重连尝试次数；成功 `connection=open` 时重置。 */
  reconnectAttempts: number
  /** 已调度的重连定时器句柄，便于 shutdown 时清除。 */
  reconnectTimer: NodeJS.Timeout | null
  /** 见 `StartCommand.selfChatMode`。 */
  selfChatMode: boolean
  /** 追加到自聊出站消息前的前缀（非空）。 */
  responsePrefix: string
  /**
   * 最近发送过的消息 ID 的有界 LRU。用于从 `messages.upsert` 中过滤 agent 自身的回声——
   * 第一道防线；前缀检查则是 worker 重启导致 ID 丢失时的兜底。
   */
  sentIds: Set<string>
  /**
   * socket 最近一次切换到 `connection: 'open'` 的 Unix 秒数。
   * 用于跳过连接后立即以 `upsert.type === 'append'` 到达的历史同步消息——
   * 我们只路由比这个挂钟时间截断点（减去少量宽限）更新的消息。
   */
  connectedAtSec: number
}

let session: SessionState | null = null

/** 限制重试次数，避免永久损坏的凭证陷入无限循环。 */
const MAX_RECONNECT_ATTEMPTS = 10

/** selfChatMode 开启但调用方未指定前缀时的兜底前缀。 */
const DEFAULT_RESPONSE_PREFIX = '🤖'

/**
 * 带 30s 上限的指数退避：1s、2s、4s、8s、16s、30s、30s、……
 * 以 attempts>=1 调用。
 */
function reconnectDelayMs(attempts: number): number {
  const exp = Math.min(attempts - 1, 5)
  return Math.min(1_000 * 2 ** exp, 30_000)
}

/**
 * 当 `selfChatMode` 开启且目标通道为 self-JID 时，把 `responsePrefix` 追加到 `text` 前。
 * 幂等：如果文本已以该前缀开头（例如转发/编辑路径重新发送），则保持不变。
 */
function applyPrefixIfSelfChat(state: SessionState, channelId: string, text: string): string {
  if (!state.selfChatMode) return text
  const selfJid = bareJid(state.sock.user?.id)
  const selfLid = bareJid(state.sock.user?.lid)
  const bareChannel = bareJid(channelId)
  if (!bareChannel) return text
  const isSelfChat =
    (selfJid !== null && bareChannel === selfJid) ||
    (selfLid !== null && bareChannel === selfLid)
  if (!isSelfChat) return text
  if (text.startsWith(state.responsePrefix)) return text
  return `${state.responsePrefix} ${text}`
}

async function loadBaileys(): Promise<BaileysModule | null> {
  try {
    // Baileys 在构建时打包进 worker.cjs；使用动态形式是为了把这一调用点
    // 隔离在 try/catch 之后，应对运行时初始化失败。
    const mod = (await import('@whiskeysockets/baileys')) as unknown as BaileysModule
    return mod
  } catch (err) {
    log('baileys load failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function startSession(
  authStateDir: string,
  pairingMode: 'qr' | 'code',
  selfChatMode: boolean,
  responsePrefix: string,
): Promise<void> {
  if (session) {
    emit({ type: 'error', message: 'Session already started' })
    return
  }
  // 构建来源信息——这是主进程在 stderr 上看到的第一行日志，运维人员据此确认
  // 实际运行的是哪个 bundle。同时也会包含在 `ready` 事件里，用于结构化日志。
  log(
    `starting — build=${WORKER_BUILD_ID} sha=${WORKER_GIT_SHA} selfChatMode=${selfChatMode} pairingMode=${pairingMode}`,
  )
  const baileys = await loadBaileys()
  if (!baileys) {
    emit({
      type: 'unavailable',
      reason: 'baileys_load_failed',
      message: 'WhatsApp library failed to initialize. Check the logs for details.',
    })
    process.exit(0)
  }

  try {
    mkdirSync(authStateDir, { recursive: true })
  } catch (err) {
    emit({
      type: 'unavailable',
      reason: 'auth_state_error',
      message: `Cannot create auth state dir: ${err instanceof Error ? err.message : String(err)}`,
    })
    process.exit(0)
  }

  const { state, saveCreds } = await baileys.useMultiFileAuthState(authStateDir)
  const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  emit({
    type: 'ready',
    baileysVersion: version?.join('.'),
    buildId: WORKER_BUILD_ID,
    gitSha: WORKER_GIT_SHA,
  })

  const makeWASocket = baileys.makeWASocket ?? baileys.default
  if (typeof makeWASocket !== 'function') {
    emit({
      type: 'unavailable',
      reason: 'baileys_load_failed',
      message: 'Baileys export shape unexpected: makeWASocket not callable',
    })
    process.exit(0)
  }

  /**
   * 构建一个绑定到持久化 `state` 的新 Baileys socket。
   * 启动时调用一次，每次非 loggedOut 重连时再调用一次。
   * `creds.update` 持久化会让 `state` 保持最新，因此每个新 socket 都用
   * 磁盘上最新的凭证做认证。
   */
  const bootSock = (): BaileysSock => {
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: baileys.Browsers.macOS('Craft Agent'),
      version,
      logger: silentLogger,
    }) as BaileysSock

    sock.ev.on('creds.update', () => void saveCreds())

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u as {
        connection?: string
        lastDisconnect?: { error?: { output?: { statusCode?: number } } }
        qr?: string
      }
      if (qr && pairingMode === 'qr') {
        emit({ type: 'qr', qr })
      }
      if (connection === 'open') {
        if (session) {
          session.reconnectAttempts = 0
          session.connectedAtSec = Math.floor(Date.now() / 1000)
        }
        emit({ type: 'connected', jid: sock.user?.id, name: sock.user?.name })
        return
      }
      if (connection !== 'close') return

      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === baileys.DisconnectReason.loggedOut
      emit({
        type: 'disconnected',
        loggedOut,
        reason: loggedOut ? 'Logged out' : `statusCode=${statusCode ?? 'unknown'}`,
      })

      if (loggedOut) {
        session = null
        process.exit(0)
        return
      }

      // 非登出关闭——包括 QR 配对后立即触发的 Baileys 515「Stream Errored
      // (restart required)」，以及后续任何短暂网络故障。用相同的持久化凭证重建 socket。
      // 遵守 shutdown 信号，并限制重试次数，避免永久损坏状态陷入无限循环。
      if (!session || session.shuttingDown) return

      session.reconnectAttempts++
      if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        emit({
          type: 'unavailable',
          reason: 'reconnect_exhausted',
          message: `WhatsApp reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts (last statusCode=${statusCode ?? 'unknown'})`,
        })
        session = null
        process.exit(0)
        return
      }

      const delay = reconnectDelayMs(session.reconnectAttempts)
      log(
        `reconnecting in ${delay}ms (attempt ${session.reconnectAttempts}, statusCode=${statusCode ?? 'unknown'})`,
      )
      session.reconnectTimer = setTimeout(() => {
        if (!session || session.shuttingDown) return
        session.reconnectTimer = null
        try {
          session.sock = bootSock()
        } catch (err) {
          log('bootSock threw during reconnect:', err instanceof Error ? err.message : String(err))
          // 让下一次 close 事件驱动退避——或者如果抛错是同步且致命的，
          // 重试次数上限会终止循环。
        }
      }, delay)
    })

    sock.ev.on('messages.upsert', (upsert) => {
      // 接受 'notify'（来自其他账号的新入站）和 'append'
      // （服务端同步——包括用户在其他设备上输入到自聊的消息，自聊就是这样
      // 投递到这台关联设备的）。拒绝未知类型（例如用于分页的 'prepend'）。
      if (upsert.type !== 'notify' && upsert.type !== 'append') return
      if (!session) return

      // debug 级别可见，方便排查路由问题时在主日志里快速发现
      // `upsert.type`/批量大小异常。
      log(`upsert type=${upsert.type} count=${upsert.messages.length}`)

      // 历史同步防护：Baileys 每次连接都会把旧消息以 'append' 重新投递。
      // 只路由比上次 open 时间更新的消息，留 5s 宽限应对时钟偏差。
      const cutoff = session.connectedAtSec - 5
      const selfJid = bareJid(sock.user?.id)
      const selfLid = bareJid(sock.user?.lid)

      // 逐消息处理是异步的（涉及媒体下载）。对整批消息做 fire-and-forget，
      // 并对每条消息单独 try/catch——Baileys 的事件处理器不能抛错，
      // 单个失败的媒体下载也不能影响其余消息。
      const sess = session
      void (async () => {
        for (const msg of upsert.messages as Array<Record<string, unknown>>) {
          try {
            await processUpsertMessage(
              msg,
              { cutoff, selfJid, selfLid },
              sess,
              emit,
              log,
            )
          } catch (err) {
            log(`upsert error: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      })()
    })

    return sock
  }

  const effectivePrefix =
    selfChatMode && responsePrefix.trim().length > 0 ? responsePrefix : DEFAULT_RESPONSE_PREFIX

  const sock = bootSock()
  session = {
    baileys,
    sock,
    saveCreds,
    pairingMode,
    authStateDir,
    shuttingDown: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    selfChatMode,
    responsePrefix: effectivePrefix,
    sentIds: new Set<string>(),
    connectedAtSec: 0,
  }
}

async function handleCommand(cmd: WorkerCommand): Promise<void> {
  switch (cmd.type) {
    case 'start': {
      await startSession(
        cmd.authStateDir,
        cmd.pairingMode ?? 'code',
        cmd.selfChatMode ?? false,
        cmd.responsePrefix ?? DEFAULT_RESPONSE_PREFIX,
      ).catch((err) => {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      return
    }
    case 'submit_pairing_phone': {
      if (!session) {
        emit({ type: 'error', message: 'Not started' })
        return
      }
      try {
        const code = await session.sock.requestPairingCode(cmd.phoneNumber)
        emit({ type: 'pairing_code', code })
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    case 'send_text': {
      if (!session) {
        emit({ type: 'send_result', id: cmd.id, ok: false, error: 'Not connected' })
        return
      }
      try {
        const text = applyPrefixIfSelfChat(session, cmd.channelId, cmd.text)
        const res = await session.sock.sendMessage(cmd.channelId, { text })
        if (res?.key?.id) rememberSentId(session.sentIds, res.key.id)
        emit({ type: 'send_result', id: cmd.id, ok: true, messageId: res?.key?.id })
      } catch (err) {
        emit({
          type: 'send_result',
          id: cmd.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'send_file': {
      if (!session) {
        emit({ type: 'send_result', id: cmd.id, ok: false, error: 'Not connected' })
        return
      }
      try {
        const buf = Buffer.from(cmd.dataBase64, 'base64')
        const caption = cmd.caption !== undefined
          ? applyPrefixIfSelfChat(session, cmd.channelId, cmd.caption)
          : undefined
        const res = await session.sock.sendMessage(cmd.channelId, {
          document: buf,
          fileName: cmd.filename,
          mimetype: cmd.mimeType ?? 'application/octet-stream',
          caption,
        })
        if (res?.key?.id) rememberSentId(session.sentIds, res.key.id)
        emit({ type: 'send_result', id: cmd.id, ok: true, messageId: res?.key?.id })
      } catch (err) {
        emit({
          type: 'send_result',
          id: cmd.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'shutdown': {
      if (session) {
        session.shuttingDown = true
        if (session.reconnectTimer) {
          clearTimeout(session.reconnectTimer)
          session.reconnectTimer = null
        }
        try {
          session.sock.end()
        } catch {
          // 忽略
        }
        session = null
      }
      process.exit(0)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// stdin 读取器
// ---------------------------------------------------------------------------

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  const { messages, rest } = parseFrames<WorkerCommand>(stdinBuffer)
  stdinBuffer = rest
  for (const msg of messages) {
    void handleCommand(msg)
  }
})

process.stdin.on('end', () => {
  if (session) {
    session.shuttingDown = true
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer)
      session.reconnectTimer = null
    }
    try {
      session.sock.end()
    } catch {
      // 忽略
    }
  }
  process.exit(0)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
