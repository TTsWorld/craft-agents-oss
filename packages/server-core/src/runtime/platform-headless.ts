/**
 * Headless 模式下的 PlatformServices 实现。
 *
 * 在 Bun 环境下运行，不使用 Electron：
 * - 图像处理用 sharp
 * - 日志用 console
 * - GUI 相关方法（openPath、openExternal、quit 等）保持 undefined，
 *   handler 用可选链或能力路由来处理
 */

import { join } from 'path'
import type { PlatformServices, Logger } from './platform'

/**
 * 基于 console 的 Logger，符合 Logger 接口。
 *
 * 每行带 ISO 时间戳和日志级别，方便 grep。
 */
function createConsoleLogger(): Logger {
  const fmt = (level: string, args: unknown[]) => {
    const ts = new Date().toISOString()
    const parts = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    return `${ts} ${level.toUpperCase().padEnd(5)} ${parts}`
  }
  return {
    info: (...args) => console.log(fmt('info', args)),
    warn: (...args) => console.warn(fmt('warn', args)),
    error: (...args) => console.error(fmt('error', args)),
    debug: (...args) => {
      if (process.env.CRAFT_DEBUG === 'true' || process.env.CRAFT_IS_PACKAGED !== 'true') {
        console.debug(fmt('debug', args))
      }
    },
  }
}

/**
 * 创建 headless（Bun）模式下的 PlatformServices。
 *
 * 环境变量：
 * - CRAFT_APP_ROOT — 覆盖 appRootPath（默认 cwd）
 * - CRAFT_RESOURCES_PATH — 覆盖 resourcesPath（默认 cwd/resources）
 * - CRAFT_IS_PACKAGED — 'true' 表示生产环境（默认 false）
 * - CRAFT_VERSION — 应用版本号（默认 '0.0.0-dev'）
 * - CRAFT_DEBUG — 'true' 开启 debug 日志
 */
export function createHeadlessPlatform(options?: { appVersion?: string }): PlatformServices {
  const logger = createConsoleLogger()
  const isDebugMode = process.env.CRAFT_DEBUG === 'true' || process.env.CRAFT_IS_PACKAGED !== 'true'

  return {
    appRootPath: process.env.CRAFT_APP_ROOT || process.cwd(),
    resourcesPath: process.env.CRAFT_RESOURCES_PATH || join(process.cwd(), 'resources'),
    isPackaged: process.env.CRAFT_IS_PACKAGED === 'true',
    appVersion: process.env.CRAFT_VERSION || options?.appVersion || '0.0.0-dev',

    imageProcessor: {
      async getMetadata(buffer) {
        const sharp = (await import('sharp')).default
        const m = await sharp(buffer).metadata().catch(() => null)
        return (m?.width && m?.height) ? { width: m.width, height: m.height } : null
      },
      async process(input, opts = {}) {
        const sharp = (await import('sharp')).default
        let pipeline = sharp(input)
        if (opts.resize) {
          pipeline = pipeline.resize(opts.resize.width, opts.resize.height, {
            fit: opts.fit ?? 'inside',
          })
        }
        if (opts.format === 'jpeg') {
          pipeline = pipeline.jpeg({ quality: opts.quality ?? 90 })
        } else {
          pipeline = pipeline.png()
        }
        return pipeline.toBuffer()
      },
    },

    logger,
    isDebugMode,

    captureError: (err) => {
      logger.error('[captureError]', err.message, err.stack)
    },

    // GUI 方法故意保持 undefined
  }
}
