/**
 * thumbnail-protocol.ts —— 缩略图自定义协议处理器。
 *
 * 注册 `thumbnail://` 协议，为会话侧边栏中的文件提供缩略图。
 * 浏览器原生通过 <img src="thumbnail://encoded-path" /> 异步加载。
 *
 * 缩略图生成策略（跨平台）：
 * - macOS/Windows：nativeImage.createThumbnailFromPath()，使用系统级缩略图缓存
 *  （Quick Look / Shell API），速度快，支持图片、PDF、Office 文档。
 * - Linux：nativeImage.createFromPath() + resize()，使用 Chromium Skia 引擎，
 *   仅支持图片，不支持 PDF/Office。
 *
 * 缓存：
 * - 内存 LRU，key 为 path + mtime；缓存未命中时生成。
 * - 文件 mtime 变化时自动失效。
 * - 上限 MAX_CACHE_ENTRIES，控制内存占用。
 */

import { protocol, nativeImage } from 'electron'
import { stat } from 'fs/promises'
import { isAbsolute } from 'path'
import { mainLog } from './logger'

/** 缩略图输出尺寸（宽高相同） */
const THUMBNAIL_SIZE = 64

/** 内存 LRU 缓存最大条目数 */
const MAX_CACHE_ENTRIES = 200

/** 支持缩略图的图片扩展名 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif',
])

/** 仅能通过 OS 缩略图 API 处理的扩展名（macOS/Windows） */
const OS_THUMBNAIL_EXTENSIONS = new Set([
  'pdf', 'svg', 'psd', 'ai',
])

/** 所有可能生成缩略图的扩展名 */
const ALL_PREVIEWABLE = new Set([...IMAGE_EXTENSIONS, ...OS_THUMBNAIL_EXTENSIONS])

// 内存 LRU 缓存：path -> { mtime, data }
const cache = new Map<string, { mtime: number; data: Buffer }>()

/**
 * 缓存超过上限时淘汰最旧的条目。
 * Map 按插入顺序迭代，所以第一个条目最旧。
 */
function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }
}

/**
 * 当前平台是否支持 OS 级缩略图生成。
 * nativeImage.createThumbnailFromPath() 只在 macOS 和 Windows 上可用。
 */
const supportsOSThumbnails = process.platform === 'darwin' || process.platform === 'win32'

/**
 * 为指定文件路径生成缩略图 buffer。
 * 成功返回 PNG buffer，失败或不支持返回 null。
 */
async function generateThumbnail(filePath: string, ext: string): Promise<Buffer | null> {
  // 策略 1：OS 级缩略图（macOS/Windows），支持图片、PDF 等
  if (supportsOSThumbnails) {
    try {
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
      })
      if (!thumbnail.isEmpty()) {
        return thumbnail.toPNG()
      }
    } catch {
      // OS 缩略图失败，继续走基于 Skia 的图片兜底方案
    }
  }

  // 策略 2：基于 Skia 的 resize（全平台），仅支持图片
  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const img = nativeImage.createFromPath(filePath)
      if (img.isEmpty()) return null
      const resized = img.resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE })
      return resized.toPNG()
    } catch {
      return null
    }
  }

  // 当前平台不支持该文件类型
  return null
}

/**
 * 注册 thumbnail:// 自定义协议 scheme。
 * 必须在 app.whenReady() 之前调用——Electron 要求在应用初始化最早阶段注册 scheme。
 */
export function registerThumbnailScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'thumbnail',
      privileges: {
        // 允许渲染进程从此 scheme 获取资源
        supportFetchAPI: true,
        // standard scheme 支持常规 URL 解析（host、path 等）
        standard: true,
        // 允许渲染进程跨域访问
        corsEnabled: true,
        // 流式支持，便于高效返回响应
        stream: true,
      },
    },
  ])
}

/**
 * 注册 thumbnail:// 协议的实际处理器。
 * 必须在 app.whenReady() 之后调用——处理请求并返回缩略图响应。
 *
 * URL 格式：thumbnail://thumb/<encodeURIComponent(absolutePath)>
 * 示例：
 *   macOS:   thumbnail://thumb/%2FUsers%2Ffoo%2Fimage.png
 *   Windows: thumbnail://thumb/C%3A%5CUsers%5Cfoo%5Cimage.png
 */
export function registerThumbnailHandler(): void {
  protocol.handle('thumbnail', async (request) => {
    try {
      // 从 URL 解析文件路径
      // 格式：thumbnail://thumb/<encoded-path>
      // URL.pathname 包含前导 /，解码前要先去掉
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.slice(1))

      // 基础校验：必须是绝对路径（所有平台通用）
      if (!filePath || !isAbsolute(filePath)) {
        return new Response(null, { status: 400 })
      }

      // 检查扩展名是否可预览
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      if (!ALL_PREVIEWABLE.has(ext)) {
        return new Response(null, { status: 404 })
      }

      // 获取文件 mtime 用于缓存校验
      let mtime: number
      try {
        const fileStat = await stat(filePath)
        mtime = fileStat.mtimeMs
      } catch {
        // 文件不存在或无法访问
        return new Response(null, { status: 404 })
      }

      // 检查缓存：路径匹配且 mtime 未变化才算命中
      const cached = cache.get(filePath)
      if (cached && cached.mtime === mtime) {
        return new Response(new Uint8Array(cached.data), {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'max-age=3600',
          },
        })
      }

      // 缓存未命中，生成缩略图
      const data = await generateThumbnail(filePath, ext)
      if (!data) {
        return new Response(null, { status: 404 })
      }

      // 存入缓存（delete+set 把项移到末尾，实现 LRU 行为）
      cache.delete(filePath)
      cache.set(filePath, { mtime, data })
      evictIfNeeded()

      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'max-age=3600',
        },
      })
    } catch (error) {
      mainLog.error('Thumbnail protocol error:', error)
      return new Response(null, { status: 500 })
    }
  })

  mainLog.info('Registered thumbnail:// protocol handler')
}
