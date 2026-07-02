/**
 * logger.ts —— 主进程日志模块。
 *
 * 负责配置 electron-log 的日志格式、作用域，并提供两个专用日志：
 * 1. messagingGatewayLog：固定路径的 messaging-gateway.log，方便跨构建模式排查消息网关问题。
 * 2. autoUpdateLog：固定路径的 auto-update.log，解决生产环境 electron-log 被关闭后无法诊断更新安装失败的问题。
 */
import log from 'electron-log/main'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  MessagingLogContext,
  MessagingLogMeta,
  MessagingLogger,
} from '@craft-agent/messaging-gateway'

/**
 * 统一判断当前是否处于调试模式。
 *
 * 优先级：
 * 1) 命令行带 --debug 则强制开启
 * 2) CRAFT_IS_PACKAGED 环境变量显式设置
 * 3) Electron 运行时启发式：defaultApp 为开发模式，否则为打包模式
 * 4) 非 Electron 运行时（headless Bun / node --check）默认开启调试
 */
function resolveDebugMode(): boolean {
  if (process.argv.includes('--debug')) return true

  const packagedEnv = process.env.CRAFT_IS_PACKAGED
  if (packagedEnv === 'true') return false
  if (packagedEnv === 'false') return true

  const isElectronRuntime = typeof process.versions?.electron === 'string'
  if (isElectronRuntime) {
    if (process.defaultApp) return true
    return false
  }

  return true
}

export const isDebugMode = resolveDebugMode()

// 根据是否调试模式配置日志传输目标（文件 / 控制台）
if (isDebugMode) {
  // 文件用 JSON 格式（便于 agent 解析）
  // 注意：format 签名为 (params: FormatParams) => any[]，其中 params.message 包含 LogMessage 字段
  log.transports.file.format = ({ message }) => [
    JSON.stringify({
      timestamp: message.date.toISOString(),
      level: message.level,
      scope: message.scope,
      message: message.data,
    }),
  ]

  log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB

  // 调试模式下控制台输出可读格式
  // 注意：format 必须返回数组，因为 electron-log 的 transformStyles 会对其调用 .reduce()
  log.transports.console.format = ({ message }) => {
    const scope = message.scope ? `[${message.scope}]` : ''
    const level = message.level.toUpperCase().padEnd(5)
    const data = message.data
      .map((d: unknown) => (typeof d === 'object' ? JSON.stringify(d) : String(d)))
      .join(' ')
    return [`${message.date.toISOString()} ${level} ${scope} ${data}`]
  }
  log.transports.console.level = 'debug'
} else {
  // 生产环境禁用文件和控制台传输
  log.transports.file.level = false
  log.transports.console.level = false
}

// 导出带作用域的日志器，便于按模块过滤
export const mainLog = log.scope('main')
export const sessionLog = log.scope('session')
export const handlerLog = log.scope('handler')
export const windowLog = log.scope('window')
export const agentLog = log.scope('agent')
export const searchLog = log.scope('search')

/**
 * messaging-gateway 专用日志路径。
 *
 * 不放在 Electron 管理的 logs 目录里，这样无论 debug 还是 production 构建，
 * 都能在一个稳定路径独立查看消息网关问题。
 */
export const messagingGatewayLogPath = join(homedir(), '.craft-agent', 'logs', 'messaging-gateway.log')
const messagingGatewayBackupPath = `${messagingGatewayLogPath}.1`
const MESSAGING_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5MB

function ensureMessagingLogDir(): void {
  mkdirSync(dirname(messagingGatewayLogPath), { recursive: true })
}

function rotateMessagingLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(messagingGatewayLogPath)) return
  try {
    const currentSize = statSync(messagingGatewayLogPath).size
    if (currentSize + nextLineBytes <= MESSAGING_LOG_MAX_BYTES) return
    if (existsSync(messagingGatewayBackupPath)) {
      rmSync(messagingGatewayBackupPath, { force: true })
    }
    renameSync(messagingGatewayLogPath, messagingGatewayBackupPath)
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to rotate dedicated log file', normalizeLogValue(error))
  }
}

function normalizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = normalizeLogValue(cause, depth + 1)
    if (value.stack) out.stack = value.stack
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeLogValue(inner, depth + 1)
    }
    return out
  }
  return value
}

function normalizeMeta(meta?: MessagingLogMeta): Record<string, unknown> {
  if (!meta) return {}
  const normalized = normalizeLogValue(meta)
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { meta: normalized }
}

function writeMessagingGatewayLog(
  level: 'info' | 'warn' | 'error',
  context: MessagingLogContext,
  message: string,
  meta?: MessagingLogMeta,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'messaging-gateway',
    ...context,
    ...normalizeMeta(meta),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  try {
    ensureMessagingLogDir()
    rotateMessagingLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(messagingGatewayLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to write dedicated log entry', {
      error: normalizeLogValue(error),
      attemptedEntry: entry,
    })
  }

  if (level === 'error') {
    mainLog.error('[messaging-gateway]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[messaging-gateway]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[messaging-gateway]', message, entry)
  }
}

class StructuredMessagingGatewayLogger implements MessagingLogger {
  constructor(private readonly context: MessagingLogContext = {}) {}

  child(context: MessagingLogContext): MessagingLogger {
    return new StructuredMessagingGatewayLogger({
      ...this.context,
      ...context,
    })
  }

  info(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('info', this.context, message, meta)
  }

  warn(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('warn', this.context, message, meta)
  }

  error(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('error', this.context, message, meta)
  }
}

export const messagingGatewayLog: MessagingLogger = new StructuredMessagingGatewayLogger({
  component: 'root',
})

/**
 * 自动更新专用日志路径。
 *
 * 打包构建里 Electron 的文件/控制台日志会被关闭，导致 `[auto-update]` / `[update-flow]`
 * 等诊断信息丢失，现场无法排查更新安装失败。这个专用日志始终启用、按大小轮转，
 * 与上面的 messaging-gateway 日志思路一致。
 */
export const autoUpdateLogPath = join(homedir(), '.craft-agent', 'logs', 'auto-update.log')
const autoUpdateBackupPath = `${autoUpdateLogPath}.1`
const AUTO_UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024 // 2MB

function rotateAutoUpdateLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(autoUpdateLogPath)) return
  try {
    const currentSize = statSync(autoUpdateLogPath).size
    if (currentSize + nextLineBytes <= AUTO_UPDATE_LOG_MAX_BYTES) return
    if (existsSync(autoUpdateBackupPath)) {
      rmSync(autoUpdateBackupPath, { force: true })
    }
    renameSync(autoUpdateLogPath, autoUpdateBackupPath)
  } catch (error) {
    mainLog.warn('[auto-update] failed to rotate dedicated log file', normalizeLogValue(error))
  }
}

function writeAutoUpdateLog(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'auto-update',
    ...(meta !== undefined ? { meta: normalizeLogValue(meta) } : {}),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  try {
    mkdirSync(dirname(autoUpdateLogPath), { recursive: true })
    rotateAutoUpdateLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(autoUpdateLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[auto-update] failed to write dedicated log entry', normalizeLogValue(error))
  }

  // 同时镜像到 Electron logger（生产环境 transport 被禁用，这里无实际操作；
  // 但保留 --debug 时的控制台/文件输出）。
  if (level === 'error') {
    mainLog.error('[auto-update]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[auto-update]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[auto-update]', message, entry)
  }
}

/** 始终启用的结构化自动更新日志器（参见 #891）。 */
export const autoUpdateLog = {
  info: (message: string, meta?: unknown) => writeAutoUpdateLog('info', message, meta),
  warn: (message: string, meta?: unknown) => writeAutoUpdateLog('warn', message, meta),
  error: (message: string, meta?: unknown) => writeAutoUpdateLog('error', message, meta),
}

export function getAutoUpdateLogFilePath(): string {
  return autoUpdateLogPath
}

/**
 * 获取当前 Electron 主日志文件路径。
 * 如果文件日志被禁用则返回 undefined。
 */
export function getLogFilePath(): string | undefined {
  if (!isDebugMode) return undefined
  return log.transports.file.getFile()?.path
}

export function getMessagingGatewayLogFilePath(): string {
  return messagingGatewayLogPath
}

export default log
