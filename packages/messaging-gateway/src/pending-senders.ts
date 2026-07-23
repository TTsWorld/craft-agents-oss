/**
 * PendingSendersStore —— access-control 层最近拒绝的发送方的有界记录。
 *
 * 在 Settings UI 里以「Pending requests」呈现，让运营者一键把某个发送方
 * 提升为 owners 列表成员。每个 workspace 持久化到
 * `messaging/pending.json`。
 *
 * 边界：
 *  - 每个 workspace LRU 最多 50 条（溢出时按最近性裁剪）。
 *  - 7 天 TTL —— 超过的条目在读/写时被丢弃。
 *  - 文件存储尽力而为。丢文件无害：下一次被拒的尝试会重新填充。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  MessagingLogger,
  PendingRejectReason,
  PendingSender,
  PlatformType,
} from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

const MAX_ENTRIES = 50
const TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface RecordRejectionInput {
  platform: PlatformType
  senderId: string
  senderName?: string
  senderUsername?: string
  /**
   * 发送方被拒的原因。未提供时默认为 `'not-owner'`
   *（与原始签名的向后兼容）。
   */
  reason?: PendingRejectReason
  /** `'not-on-binding-allowlist'` 拒绝时的 binding 上下文。 */
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

export class PendingSendersStore {
  private entries: PendingSender[] = []
  private readonly filePath: string
  private readonly dirPath: string
  private readonly log: MessagingLogger
  private changeListener?: () => void

  constructor(storageDir: string, logger: MessagingLogger = NOOP_LOGGER) {
    this.dirPath = storageDir
    this.filePath = join(storageDir, 'pending.json')
    this.log = logger
    this.load()
  }

  /** 注册一个回调，在任意变更被持久化后触发。 */
  onChange(fn: () => void): void {
    this.changeListener = fn
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  list(platform?: PlatformType): PendingSender[] {
    const now = Date.now()
    return this.entries
      .filter((e) => now - e.lastAttemptAt < TTL_MS)
      .filter((e) => (platform ? e.platform === platform : true))
      .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
  }

  // -------------------------------------------------------------------------
  // 变更
  // -------------------------------------------------------------------------

  /**
   * 记录一次被拒的尝试。条目以
   * `(platform, senderId, reason, bindingId)` 为键 —— 同一个发送方命中
   * 不同 binding 会落在不同的行上，这样运营者可以独立决定每一行。
   * 同一 key 的重复尝试会累加 `attemptCount`、刷新 `lastAttemptAt`
   * 并更新显示元数据。
   *
   * 插入溢出时触发 LRU 驱逐。返回合并后的条目，
   * 这样调用方无需重新查询就能记录当前 attemptCount。
   */
  recordRejection(input: RecordRejectionInput): PendingSender {
    const now = Date.now()
    this.evictExpired(now)

    const reason: PendingRejectReason = input.reason ?? 'not-owner'
    const bindingId = input.bindingId

    const idx = this.entries.findIndex(
      (e) =>
        e.platform === input.platform &&
        e.userId === input.senderId &&
        (e.reason ?? 'not-owner') === reason &&
        (e.bindingId ?? null) === (bindingId ?? null),
    )
    let merged: PendingSender
    if (idx >= 0) {
      const existing = this.entries[idx]!
      merged = {
        ...existing,
        // 如果本次尝试带来了更好的信息，刷新显示元数据。
        displayName: input.senderName ?? existing.displayName,
        username: input.senderUsername ?? existing.username,
        lastAttemptAt: now,
        attemptCount: existing.attemptCount + 1,
        reason,
        ...(input.bindingId ? { bindingId: input.bindingId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      }
      this.entries.splice(idx, 1)
      this.entries.unshift(merged)
    } else {
      merged = {
        platform: input.platform,
        userId: input.senderId,
        displayName: input.senderName,
        username: input.senderUsername,
        lastAttemptAt: now,
        attemptCount: 1,
        reason,
        ...(input.bindingId ? { bindingId: input.bindingId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      }
      this.entries.unshift(merged)
      if (this.entries.length > MAX_ENTRIES) {
        this.entries = this.entries.slice(0, MAX_ENTRIES)
      }
    }

    this.save()
    return merged
  }

  /**
   * 丢弃一条或多条匹配所提供 key 的条目。当只提供
   * `(platform, userId)` 时，该发送方的所有 reason/binding 行都会被丢弃 ——
   * 用于发送方通过「Allow as workspace owner」成为 workspace owner 后，
   * 不在背后留下陈旧行。指定 `reason`（以及可选的 `bindingId`）
   * 可把 dismiss 收窄到单行。
   *
   * 有任何条目被移除时返回 true。
   */
  dismiss(
    platform: PlatformType,
    userId: string,
    opts?: { reason?: PendingRejectReason; bindingId?: string },
  ): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => {
      if (e.platform !== platform || e.userId !== userId) return true
      if (opts?.reason !== undefined && (e.reason ?? 'not-owner') !== opts.reason) return true
      if (opts?.bindingId !== undefined && e.bindingId !== opts.bindingId) return true
      return false
    })
    if (this.entries.length === before) return false
    this.save()
    return true
  }

  /** 丢弃该平台的所有条目。断开/遗忘后使用。 */
  clearPlatform(platform: PlatformType): number {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.platform !== platform)
    const removed = before - this.entries.length
    if (removed > 0) this.save()
    return removed
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  private evictExpired(now: number): void {
    const cutoff = now - TTL_MS
    const fresh = this.entries.filter((e) => e.lastAttemptAt >= cutoff)
    if (fresh.length !== this.entries.length) {
      this.entries = fresh
      this.save()
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      const now = Date.now()
      this.entries = parsed
        .filter(isPendingSender)
        .filter((e) => now - e.lastAttemptAt < TTL_MS)
    } catch (err) {
      this.log.error('failed to load pending senders; resetting', {
        event: 'pending_senders_load_failed',
        filePath: this.filePath,
        error: err,
      })
      this.entries = []
    }
  }

  private save(): void {
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf-8')
      this.changeListener?.()
    } catch (err) {
      this.log.error('failed to save pending senders', {
        event: 'pending_senders_save_failed',
        filePath: this.filePath,
        error: err,
      })
    }
  }
}

function isPendingSender(value: unknown): value is PendingSender {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.platform === 'telegram' || v.platform === 'whatsapp' || v.platform === 'lark') &&
    typeof v.userId === 'string' &&
    typeof v.lastAttemptAt === 'number' &&
    typeof v.attemptCount === 'number'
  )
}
