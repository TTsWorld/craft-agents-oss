/**
 * WhatsApp 消息的媒体附件提取。
 *
 * 纯辅助函数，有意与 worker.ts 分离，这样单元测试可以验证变体扇出和大小限制，
 * 而无需启动 worker（worker.ts 会在模块加载时安装 stdin 和信号处理句柄）。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Buffer as BufferType } from 'node:buffer'
import type { BaileysModule } from './worker'
import type { WorkerIncomingAttachment } from './protocol'

/** 与 Telegram 适配器的上限保持一致，让跨平台行为统一。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
}

function pickExtension(mime: string | undefined, fallback = '.bin'): string {
  if (!mime) return fallback
  return EXT_BY_MIME[mime] ?? fallback
}

interface VariantSpec {
  key: 'audioMessage' | 'imageMessage' | 'videoMessage' | 'documentMessage'
  type: WorkerIncomingAttachment['type']
  defaultMime: string
}

const VARIANTS: VariantSpec[] = [
  { key: 'audioMessage', type: 'voice', defaultMime: 'audio/ogg' },
  { key: 'imageMessage', type: 'photo', defaultMime: 'image/jpeg' },
  { key: 'videoMessage', type: 'video', defaultMime: 'video/mp4' },
  { key: 'documentMessage', type: 'document', defaultMime: 'application/octet-stream' },
]

/**
 * 遍历 Baileys 消息上支持的媒体变体，为每个识别到的变体返回一个
 * `WorkerIncomingAttachment`。声明大小超过上限、下载抛错、或下载后缓冲区仍超限的变体会被跳过
 * （仅记录日志，不抛异常）。
 */
export async function extractAttachments(
  baileys: BaileysModule,
  msg: Record<string, unknown>,
  log: (...args: unknown[]) => void,
): Promise<WorkerIncomingAttachment[]> {
  const m = msg.message as Record<string, unknown> | undefined
  if (!m) return []

  const out: WorkerIncomingAttachment[] = []
  for (const v of VARIANTS) {
    const node = m[v.key] as Record<string, unknown> | undefined
    if (!node) continue

    // audioMessage 带 ptt=true 时是即按即说语音消息；不带 ptt 时是音频文件
    // （转发的音乐、其他 App 的录音等）。
    let type = v.type
    if (v.key === 'audioMessage' && node.ptt !== true) type = 'audio'

    const declaredSize = Number(node.fileLength ?? 0)
    if (declaredSize > MAX_ATTACHMENT_BYTES) {
      log(`media skip: ${v.key} declared ${declaredSize} bytes exceeds cap`)
      continue
    }

    let buffer: BufferType
    try {
      buffer = await baileys.downloadMediaMessage(
        msg as Parameters<typeof baileys.downloadMediaMessage>[0],
        'buffer',
        {},
      )
    } catch (err) {
      log(`media download failed for ${v.key}:`, err instanceof Error ? err.message : String(err))
      continue
    }

    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      log(`media skip: ${v.key} buffer ${buffer.byteLength} exceeds cap`)
      continue
    }

    const mimeType = (node.mimetype as string | undefined) ?? v.defaultMime
    const ext = pickExtension(mimeType)
    const fileName =
      (node.fileName as string | undefined) ?? `${type}-${Date.now()}${ext}`
    const localPath = join(tmpdir(), `craft-wa-${randomUUID()}${ext}`)

    try {
      await writeFile(localPath, buffer)
    } catch (err) {
      log(`media write failed for ${v.key}:`, err instanceof Error ? err.message : String(err))
      continue
    }

    out.push({ type, fileName, mimeType, fileSize: buffer.byteLength, localPath })
  }
  return out
}
