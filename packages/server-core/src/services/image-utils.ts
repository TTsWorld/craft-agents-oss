/**
 * 图像处理工具
 *
 * 文件职责：
 *   - 封装对底层 ImageProcessor（实际由 sharp 等库实现）的调用。
 *   - 提供图像尺寸获取、图标缩放、API 上传前压缩/降级等常用操作。
 *   - 处理 ImageProcessor 未安装（例如 sharp 二进制缺失）的 graceful degradation。
 *
 * 依赖注入说明：
 *   - imageProcessor 是模块级变量，通过 setImageProcessor() 注入。
 *   - 这种写法类似 Golang 中在 init 阶段把全局 interface 实现赋给包级变量，
 *     避免在工具函数内部硬编码具体库。
 *
 * TS 特性小记：
 *   - `type ImageBufferInspection = { status: 'ok' } | { status: 'invalid_image' } | ...`
 *     是“标签联合类型/可辨识联合”（discriminated union）。
 *     通过公共字段 `status` 区分分支，配合 switch/if 实现类型收窄，
 *     与 Golang 中 interface + type switch 有异曲同工之妙。
 *   - `Buffer` 是 Node.js 提供的二进制数据类型，类似 Golang 的 `[]byte`。
 */
import type { ImageProcessor } from '../runtime/platform'
import { IMAGE_LIMITS } from '@craft-agent/shared/utils'

/** 图片缩放后的结果 */
export interface ImageResizeResult {
  /** 缩放后的图像二进制数据 */
  buffer: Buffer
  /** 输出宽度 */
  width: number
  /** 输出高度 */
  height: number
  /** 输出格式：png 或 jpeg */
  format: 'png' | 'jpeg'
}

/** 模块级图像处理器；必须由外部通过 setImageProcessor() 注入 */
let imageProcessor: ImageProcessor

/** 将任意错误值规范化成 Error 实例 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 判断错误是否由图像处理库未安装导致。
 * 典型场景：sharp 的二进制依赖在打包或目标机器上缺失。
 */
function isImageProcessorUnavailableError(error: unknown): boolean {
  const message = toError(error).message.toLowerCase()
  return (
    (message.includes('cannot find package') || message.includes('cannot find module'))
    && message.includes('sharp')
  )
}

/**
 * 图像缓冲区检查结果。
 * 使用 discriminated union，调用方可通过 `status` 字段做精确分支处理。
 */
export type ImageBufferInspection =
  | { status: 'ok'; width: number; height: number }
  | { status: 'invalid_image'; error?: Error }
  | { status: 'processor_unavailable'; error?: Error }

/**
 * 检查上传的图像缓冲区，区分“图像无效”与“图像处理库不可用”两种情况。
 * @param buffer - 原始图像二进制数据
 * @param processor - 当前注入的图像处理器
 * @returns 检查结果标签联合
 */
export async function inspectImageBuffer(
  buffer: Buffer,
  processor: ImageProcessor,
): Promise<ImageBufferInspection> {
  try {
    const metadata = await processor.getMetadata(buffer)
    if (metadata?.width && metadata?.height) {
      return { status: 'ok', width: metadata.width, height: metadata.height }
    }
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return { status: 'processor_unavailable', error: toError(error) }
    }
  }

  try {
    const normalized = await processor.process(buffer, { format: 'png' })
    const metadata = await processor.getMetadata(normalized)
    if (metadata?.width && metadata?.height) {
      return { status: 'ok', width: metadata.width, height: metadata.height }
    }
    return { status: 'invalid_image' }
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return { status: 'processor_unavailable', error: toError(error) }
    }
    return { status: 'invalid_image', error: toError(error) }
  }
}

/**
 * 注入图像处理器实现。
 * 通常在应用启动时调用，把基于 sharp 的 processor 赋给本模块。
 */
export function setImageProcessor(proc: ImageProcessor) {
  imageProcessor = proc
}

/**
 * 从缓冲区获取图像尺寸。
 * @param buffer - 图像二进制数据
 * @returns 宽度和高度；若无效则返回 null
 */
export async function getImageSize(buffer: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    return await imageProcessor.getMetadata(buffer)
  } catch {
    return null
  }
}

/**
 * 将图标缓冲区等比缩放至 targetSize × targetSize 范围内，输出 PNG。
 * @param buffer - 原始图像二进制数据
 * @param targetSize - 目标最大边长
 * @returns 缩放后的 PNG 缓冲区；输入无效时返回 undefined
 */
export async function resizeIconBuffer(buffer: Buffer, targetSize: number): Promise<Buffer | undefined> {
  try {
    return await imageProcessor.process(buffer, {
      resize: { width: targetSize, height: targetSize },
      fit: 'inside',
      format: 'png',
    })
  } catch {
    return undefined
  }
}

/**
 * 将图像缓冲区缩放/压缩到 Claude API 限制以内。
 *
 * 降级策略：
 * 1. 若长边超过 OPTIMAL_EDGE（1568px），先等比缩小；
 * 2. 默认输出 PNG；若是照片（isPhoto=true）则优先输出 JPEG；
 * 3. 若仍超过 maxSizeBytes，尝试 JPEG 高质量（90）压缩；
 * 4. 若仍超过，尝试 JPEG 中等质量（75）压缩；
 * 5. 若还是超过，返回 null（无法处理）。
 *
 * @param buffer - 原始图像二进制数据
 * @param options.maxSizeBytes - 最大输出字节数，默认 IMAGE_LIMITS.MAX_SIZE（5MB）
 * @param options.isPhoto - 是否优先使用 JPEG，默认 false
 * @returns 缩放后的图像数据；若无法压缩到阈值以内则返回 null
 */
export async function resizeImageForAPI(
  buffer: Buffer,
  options?: {
    /** 最大输出字节数。默认：IMAGE_LIMITS.MAX_SIZE（5MB） */
    maxSizeBytes?: number
    /** 是否优先使用 JPEG（适合照片）。默认：false */
    isPhoto?: boolean
  },
): Promise<ImageResizeResult | null> {
  const maxSize = options?.maxSizeBytes ?? IMAGE_LIMITS.MAX_SIZE
  const isPhoto = options?.isPhoto ?? false

  const metadata = await imageProcessor.getMetadata(buffer).catch(() => null)
  if (!metadata) return null

  const maxEdge = Math.max(metadata.width, metadata.height)

  // 步骤 1：若长边超过最优边长，计算目标尺寸
  let outWidth = metadata.width
  let outHeight = metadata.height

  if (maxEdge > IMAGE_LIMITS.OPTIMAL_EDGE) {
    const scale = IMAGE_LIMITS.OPTIMAL_EDGE / maxEdge
    outWidth = Math.round(metadata.width * scale)
    outHeight = Math.round(metadata.height * scale)
  }

  const needsResize = outWidth !== metadata.width || outHeight !== metadata.height

  // 步骤 2：按偏好格式编码
  let output: Buffer
  let format: 'png' | 'jpeg'

  if (isPhoto) {
    output = await imageProcessor.process(buffer, {
      ...(needsResize && { resize: { width: outWidth, height: outHeight } }),
      format: 'jpeg',
      quality: IMAGE_LIMITS.JPEG_QUALITY_HIGH,
    })
    format = 'jpeg'
  } else {
    output = await imageProcessor.process(buffer, {
      ...(needsResize && { resize: { width: outWidth, height: outHeight } }),
      format: 'png',
    })
    format = 'png'
  }

  // 步骤 3-4：若仍然过大，回退到 JPEG 压缩（先高质量，再中等质量）
  if (output.length > maxSize) {
    output = await imageProcessor.process(buffer, {
      resize: { width: outWidth, height: outHeight },
      format: 'jpeg',
      quality: IMAGE_LIMITS.JPEG_QUALITY_HIGH,
    })
    format = 'jpeg'
  }
  if (output.length > maxSize) {
    output = await imageProcessor.process(buffer, {
      resize: { width: outWidth, height: outHeight },
      format: 'jpeg',
      quality: IMAGE_LIMITS.JPEG_QUALITY_FALLBACK,
    })
  }

  // 步骤 5：仍无法压到阈值，放弃
  if (output.length > maxSize) return null

  return { buffer: output, width: outWidth, height: outHeight, format }
}
