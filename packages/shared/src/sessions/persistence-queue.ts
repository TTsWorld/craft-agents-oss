/**
 * 会话异步持久化队列
 *
 * 通过异步写入 + 防抖（debounce）避免阻塞主线程，
 * 把短时间内多次 save 合并成一次磁盘写入。
 *
 * 重要：每个会话的写入是串行的，防止 clearSessionForRecovery、
 * onSdkSessionIdUpdate 等连续 flush 同时写同一个 .tmp 文件产生竞态。
 */

import { writeFile, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

/** 队列中等待写入的任务 */
interface PendingWrite {
  data: StoredSession
  /**
   * setTimeout 返回的句柄类型。
   * 浏览器和 Node 中返回值不同，用 ReturnType<typeof setTimeout> 让 TS 自动推导。
   */
  timer: ReturnType<typeof setTimeout>
}

/**
 * header 中那些可能由外部修改的元数据签名字段。
 * 用于判断磁盘文件是否被其他进程/实例/watcher 改过。
 */
interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

/**
 * 计算 header 的元数据签名。
 * 只包含可能被 UI 或外部 watcher 修改的字段。
 */
function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

/**
 * 当检测到外部元数据变更时，把磁盘上的元数据合并回本地 header。
 * 这样队列写入不会覆盖用户在外部做的修改。
 */
function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * 持久化队列核心类。
 *
 * 每个会话独立管理：pending、inProgress、lastWrittenSignature。
 * 这种设计和 Go 里用 map[string]*sync.Mutex 保护每个 key 类似，
 * 只是这里用单线程事件循环 + Promise 串行化。
 */
class SessionPersistenceQueue {
  /** 每个会话的待写入任务 Map（key: sessionId） */
  private pending = new Map<string, PendingWrite>()
  /** 记录每个会话当前正在进行的写入 Promise，用于串行化 */
  private writeInProgress = new Map<string, Promise<void>>()
  /** 记录每个会话上次成功写入的 header 签名，用于识别自写事件 */
  private lastWrittenHeaderSignature = new Map<string, string>()
  /** 防抖等待毫秒数 */
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * 把会话加入持久化队列。
   * 如果同一个会话已有待写入任务，会覆盖为最新数据并重新计时。
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      // void 表示故意不 await，让 setTimeout 回调不返回 Promise
      void this.write(session.id)
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  /**
   * 真正写入磁盘（私有方法）。
   * 使用原子写：先写 .tmp，再 rename 覆盖原文件。
   */
  private async write(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    this.pending.delete(sessionId)

    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

      // 把路径转成可移植形式，方便跨机器迁移
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // 生成 JSONL 内容：header + 消息（每行一条）
      // 过滤掉 intermediate 消息，它们是流式过程中的临时状态
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // 队列写入不应该覆盖外部修改过的会话元数据
      //（比如 watcher 直接改 header、其他实例写入），
      // 但本地主动更新的元数据（如自动生成标题）必须保留。
      //
      // 只有当磁盘签名与我们上次写入的签名不一致时，才认为发生了外部变更。
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // 用 toPortablePath 之前的原始绝对路径来替换路径占位符
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // 原子写：先写 .tmp 再 rename 到正式文件。
      // 如果进程崩溃在半写状态，只会损坏 .tmp，原 session.jsonl 保持不变。
      //
      // 在 unlink/rename 之前先更新签名，这样 fs.watch 触发的事件
      // 能被识别为“自己写的”，不会把空闲会话的内存元数据回退。
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      const tmpFile = filePath + '.tmp'
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      // Windows 上 rename 目标存在会失败，先删除以实现跨平台兼容
      try { await unlink(filePath) } catch { /* 文件不存在时忽略 */ }
      await rename(tmpFile, filePath)
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
    }
  }

  /**
   * 立即刷新指定会话的待写入数据。
   * 如果有正在进行的写入会先等待它完成，再开始新写入。
   */
  async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)

      // 等待同会话正在进行的写入完成，避免共享 .tmp 文件冲突
      const inProgress = this.writeInProgress.get(sessionId)
      if (inProgress) {
        await inProgress
      }

      // 启动新写入并跟踪它
      const writePromise = this.write(sessionId)
      this.writeInProgress.set(sessionId, writePromise)

      try {
        await writePromise
      } finally {
        this.writeInProgress.delete(sessionId)
      }
    }
  }

  /**
   * 取消指定会话的待写入任务（例如删除会话时）。
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * 刷新所有待写入会话。应用退出前可调用。
   */
  async flushAll(): Promise<void> {
    const sessionIds = [...this.pending.keys()]
    await Promise.all(sessionIds.map(id => this.flush(id)))
  }

  /**
   * 判断指定会话是否还有待写入数据。
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * 获取上次写入某会话 header 的签名。
   * ConfigWatcher 用它抑制自己触发的事件。
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * 当前待写入任务数量。
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// 单例，整个进程共用同一个队列
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// 也导出类本身，方便测试和自定义
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
