/**
 * 平台服务抽象 — 依赖注入缝合层。
 *
 * SessionManager 和核心 handler 依赖 PlatformServices 接口，而不是直接 import 'electron'。
 * Electron 环境下实现会包装 app/shell/nativeImage；headless 环境下用 sharp + console。
 *
 * 这是典型的"依赖倒置"：核心逻辑依赖抽象，具体平台提供实现。
 */

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/**
 * 图像处理抽象。
 *
 * Electron 用 nativeImage，headless 用 sharp。
 */
export interface ImageProcessor {
  /** 获取图片尺寸，无效图片返回 null */
  getMetadata(buffer: Buffer): Promise<{ width: number; height: number } | null>

  /**
   * 处理图片：缩放、重新编码。
   */
  process(
    input: Buffer | string,
    opts?: {
      resize?: { width: number; height: number }
      fit?: 'inside' | 'cover' | 'fill'
      format?: 'png' | 'jpeg'
      quality?: number
    },
  ): Promise<Buffer>
}

/**
 * 平台服务能力集合。
 */
export interface PlatformServices {
  // -- 路径解析 --
  appRootPath: string
  resourcesPath: string
  isPackaged: boolean

  // -- 应用元数据 --
  appVersion: string

  // -- 图像处理 --
  imageProcessor: ImageProcessor

  // -- 操作系统集成（headless 下为 undefined） --
  openPath?(path: string): Promise<void>
  openExternal?(url: string): Promise<void>
  showItemInFolder?(path: string): void

  // -- 应用生命周期（headless 下为 undefined） --
  quit?(): void
  systemDarkMode?(): boolean

  // -- 可观测性 --
  logger: Logger
  isDebugMode: boolean
  getLogFilePath?(): string | undefined
  captureError?(error: Error): void
}

// ── Logger 辅助函数 ─────────────────────────────────────────────────────────

/** 平台初始化前可用的基于 console 的 Logger */
export const CONSOLE_LOGGER: Logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
}

/** 创建一个带 [scope] 前缀的 Logger */
export function createScopedLogger(base: Logger, scope: string): Logger {
  return {
    info: (...args: unknown[]) => base.info(`[${scope}]`, ...args),
    warn: (...args: unknown[]) => base.warn(`[${scope}]`, ...args),
    error: (...args: unknown[]) => base.error(`[${scope}]`, ...args),
    debug: (...args: unknown[]) => base.debug(`[${scope}]`, ...args),
  }
}
