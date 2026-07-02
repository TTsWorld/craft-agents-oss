/**
 * 会话输入附件的持久化/恢复辅助函数。
 *
 * 保存时根据附件是否有真实操作系统路径，走两条不同的轨道：
 *   - 路径轨道 P：通过 webUtils.getPathForFile 拿到绝对路径，只存 {path, name}；
 *     恢复时通过 readUserAttachment RPC 重新读取磁盘。
 *   - 内容轨道 C：没有真实路径（粘贴、网页拖拽），把字节内联存在 `ref.content` 里；
 *     恢复时直接从内存数据重建 FileAttachment，不读磁盘。
 *
 * 判定依据是 `isAbsolutePath(a.path)`。文件选择器和系统拖拽会经过
 * `webUtils.getPathForFile`（暴露在 `electronAPI.getFilePath` 上）返回绝对路径；
 * 粘贴/网页拖拽得到的只是带文件名的合成路径。
 */

import type { FileAttachment } from '@craft-agent/shared/protocol'
import type { DraftAttachmentContent, DraftAttachmentRef } from '@craft-agent/shared/config'

/** 单个附件内联内容的上限。超大粘贴内容会被丢弃（并打印 warn），避免 drafts.json 膨胀。
 *  取值与 shared readFileAttachment 读取文件时的 20 MB 上限保持一致。 */
export const CONTENT_PERSIST_CAP = 20 * 1024 * 1024

export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  return false
}

/**
 * 估算附件持久化后的字节开销。base64 编码会比原始内容膨胀约 33%，用于写入 draft 前做 20 MB 上限检查。
 */
function estimateContentBytes(a: FileAttachment): number {
  const base64Bytes = a.base64 ? Math.floor(a.base64.length * 0.75) : 0
  const textBytes = a.text ? a.text.length : 0
  return Math.max(base64Bytes, textBytes)
}

function buildContent(a: FileAttachment): DraftAttachmentContent {
  return {
    type: a.type,
    mimeType: a.mimeType,
    size: a.size,
    ...(a.base64 !== undefined ? { base64: a.base64 } : {}),
    ...(a.text !== undefined ? { text: a.text } : {}),
    ...(a.thumbnailBase64 !== undefined ? { thumbnailBase64: a.thumbnailBase64 } : {}),
  }
}

/**
 * 把运行时的 FileAttachment 转存为 DraftAttachmentRef，根据是否有真实 OS 路径选择路径轨道或内容轨道。
 *
 * 内容轨道附件若超过单附件上限，则返回 null，由调用方在 draft 中丢弃并提示用户。
 */
export function toDraftRef(a: FileAttachment): DraftAttachmentRef | null {
  if (isAbsolutePath(a.path)) {
    return { path: a.path, name: a.name }
  }
  if (estimateContentBytes(a) > CONTENT_PERSIST_CAP) {
    return null
  }
  return { path: a.path, name: a.name, content: buildContent(a) }
}

/**
 * 从内容轨道的 draft ref 重建 FileAttachment。纯数据转换，不读磁盘、不发 RPC。
 */
export function attachmentFromContentRef(ref: DraftAttachmentRef): FileAttachment | null {
  if (!ref.content) return null
  return {
    type: ref.content.type,
    path: ref.path,
    name: ref.name,
    mimeType: ref.content.mimeType,
    size: ref.content.size,
    base64: ref.content.base64,
    text: ref.content.text,
    thumbnailBase64: ref.content.thumbnailBase64,
  }
}
