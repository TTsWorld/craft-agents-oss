/**
 * Session Bundle —— 会话导出/导入的序列化格式
 *
 * SessionBundle 是会话目录的可移植表示，
 * 用于在不同 workspace 之间迁移会话（同服或跨服）。
 *
 * 它是会话分发（move/fork）、备份和分享的基础。
 */

import { existsSync, readFileSync } from 'fs'
import type { SessionHeader, StoredMessage, SessionConfig } from './types.ts'
import type { StoredSession } from './types.ts'
import { readSessionJsonl } from './jsonl.ts'
import { getSessionPath, getSessionFilePath } from './storage.ts'
import { debug } from '../utils/debug.ts'
import {
  type BundleFile,
  MAX_BUNDLE_SIZE_BYTES,
  collectDirectoryFiles,
} from '../utils/bundle-files.ts'

// 为了向后兼容，重新导出 BundleFile 和 MAX_BUNDLE_SIZE_BYTES
export { type BundleFile, MAX_BUNDLE_SIZE_BYTES } from '../utils/bundle-files.ts'

/**
 * 导出会话时要跳过的目录。
 * tmp/ 可以重新生成；dotfiles 通常是内部状态。
 */
const SKIP_DIRS = new Set(['tmp'])

/**
 * 导出会话时要跳过的文件。
 * session.jsonl 会作为结构化数据单独放在 bundle 里。
 */
const SKIP_SESSION_FILES = new Set(['session.jsonl', 'session.jsonl.tmp'])

/**
 * 分发模式，决定导入后的会话与原会话的关系。
 * - move：迁移，原会话不再保留
 * - fork：分叉，基于原会话创建分支
 */
export type DispatchMode = 'move' | 'fork'

/**
 * fork 操作所需的分支信息。
 * 让目标服务器能在 SDK 层面做真正的对话分支，
 * 这样 fork 出来的会话才能继承原会话的完整上下文。
 */
export interface BundleBranchInfo {
  /** 要基于哪个 SDK session ID 分支 */
  sdkSessionId: string
  /** SDK turn ID（分支点） */
  sdkTurnId: string
  /** SDK 会话存储用的工作目录 */
  sdkCwd: string
}

/**
 * 会话目录的序列化表示。
 * JSON 信封格式——通常会话不大（文本 + 少量附件）。
 */
export interface SessionBundle {
  /** Bundle 格式版本 */
  version: 1
  /** 会话数据（header 元数据 + 完整消息历史） */
  session: {
    /** 会话元数据（id、name、timestamps、config 等） */
    header: SessionHeader
    /** 完整消息历史 */
    messages: StoredMessage[]
  }
  /** 会话目录下的所有文件（附件、plan、数据、下载文件等） */
  files: BundleFile[]
  /** fork 操作的分支信息（fork 时由导出方填入） */
  branchInfo?: BundleBranchInfo
}

/**
 * 把会话目录序列化成 SessionBundle。
 *
 * 读取 session JSONL 和所有关联文件（附件、plan、数据、下载）。
 * 跳过 tmp/ 目录和 dotfiles；总大小超过 MAX_BUNDLE_SIZE_BYTES 时返回 null。
 *
 * @param workspaceRootPath - 包含该会话的 workspace 根目录
 * @param sessionId - 要序列化的会话 ID
 * @returns SessionBundle；不存在或超过大小限制时返回 null
 */
export function serializeSession(
  workspaceRootPath: string,
  sessionId: string,
): SessionBundle | null {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId)
  const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)

  if (!existsSync(sessionFile)) {
    debug('[bundle] Session file not found:', sessionFile)
    return null
  }

  // 读取并解析 session JSONL
  const stored = readSessionJsonl(sessionFile)
  if (!stored) {
    debug('[bundle] Failed to parse session JSONL:', sessionFile)
    return null
  }

  // 收集会话目录下的所有文件（跳过 session.jsonl 和 tmp/）
  const files = collectDirectoryFiles(sessionDir, {
    skipDirs: SKIP_DIRS,
    skipFiles: SKIP_SESSION_FILES,
  })

  // 校验 bundle 总大小
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  if (totalSize > MAX_BUNDLE_SIZE_BYTES) {
    debug(`[bundle] Session exceeds max bundle size: ${totalSize} bytes > ${MAX_BUNDLE_SIZE_BYTES} bytes`)
    return null
  }

  // 用 JSONL 原生的 header 保留预计算字段
  const rawContent = readFileSync(sessionFile, 'utf-8')
  const firstLine = rawContent.split('\n')[0]
  if (!firstLine) return null

  // 去掉服务端内部字段，这些不应该随 bundle 迁移
  const header: SessionHeader = {
    ...JSON.parse(firstLine) as SessionHeader,
    // workspaceRootPath 会由导入方重新设置
  }

  return {
    version: 1,
    session: {
      header,
      messages: stored.messages,
    },
    files,
  }
}

/**
 * 校验 SessionBundle 结构。
 * 检查版本号、必填字段和基本完整性。
 *
 * @returns 是一个 TS 类型谓词（type predicate）：返回 true 时 TS 知道参数已是 SessionBundle
 */
export function validateBundle(bundle: unknown): bundle is SessionBundle {
  if (!bundle || typeof bundle !== 'object') return false
  const b = bundle as Record<string, unknown>

  if (b.version !== 1) return false
  if (!b.session || typeof b.session !== 'object') return false

  const session = b.session as Record<string, unknown>
  if (!session.header || typeof session.header !== 'object') return false
  if (!Array.isArray(session.messages)) return false

  const header = session.header as Record<string, unknown>
  if (typeof header.id !== 'string') return false
  if (typeof header.createdAt !== 'number') return false

  if (!Array.isArray(b.files)) return false

  return true
}
