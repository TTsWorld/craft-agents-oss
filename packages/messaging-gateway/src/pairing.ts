/**
 * PairingCodeManager —— 签发并校验一次性配对码。
 *
 * 配对码为 6 位数字、5 分钟 TTL、仅存内存（从不持久化）。
 * 按 workspace 限速（默认：10 次/分钟），防止 bot token 一旦泄露后被暴力枚举。
 *
 * 消费是原子的：consume() 恰好返回一次条目，然后删除它。
 * 输错码不会计入签发侧的限速（consume 由入站聊天消息触发，
 * 那本身就是一个独立的带外信道）。
 */

import { randomInt } from 'node:crypto'
import type { PlatformType } from './types'

/**
 * 配对码意图。
 *
 * - `session`：经典流程 —— 在一个聊天里输入 `/pair <code>`，把该聊天
 *  （DM，或 Telegram 超级群话题）绑定到发起配对的 session。
 * - `workspace-supergroup`：workspace 级别设置 —— 在一个 Telegram 超级群里
 *   输入 `/pair <code>`，把该超级群注册为 workspace 接受的论坛，
 *   之后 session 可以绑定到其中特定的话题。这种类型下 `sessionId` 字段不用。
 */
export type PairingKind = 'session' | 'workspace-supergroup'

export interface PairingEntry {
  kind: PairingKind
  workspaceId: string
  /** 仅当 `kind: 'session'` 时设置。 */
  sessionId?: string
  platform: PlatformType
  code: string
  expiresAt: number
}

export interface GeneratedPairing {
  code: string
  expiresAt: number
}

export const PAIRING_TTL_MS = 5 * 60 * 1000
export const PAIRING_RATE_LIMIT_PER_MINUTE = 10
/**
 * 每个发送方对 `/pair` 尝试的上限。一个 6 位十进制配对码配合 5 分钟 TTL，
 * 暴力破解需要约 50 万次尝试。5 次/分钟 × 5 分钟 = TTL 内 25 次尝试 ——
 * 上限约 25/1,000,000。这是纵深防御；真正的保障是短 TTL。
 */
export const PAIR_CONSUME_RATE_PER_MINUTE = 5

interface Bucket {
  windowStart: number
  count: number
}

export class PairingCodeManager {
  /** 键：`${platform}:${code}` */
  private readonly entries = new Map<string, PairingEntry>()
  /** 键：workspaceId */
  private readonly buckets = new Map<string, Bucket>()
  /** 键：`${workspaceId}:${platform}:${senderId}` —— 计算尝试次数，无论对错。 */
  private readonly consumeBuckets = new Map<string, Bucket>()

  constructor(
    private readonly ttlMs: number = PAIRING_TTL_MS,
    private readonly ratePerMinute: number = PAIRING_RATE_LIMIT_PER_MINUTE,
    private readonly consumeRatePerMinute: number = PAIR_CONSUME_RATE_PER_MINUTE,
  ) {}

  /**
   * 签发一个新的配对码。
   * @throws 当 workspace 超过每分钟上限时抛出 code 为 'RATE_LIMIT' 的 Error。
   */
  generate(workspaceId: string, sessionId: string, platform: PlatformType): GeneratedPairing {
    return this.generateInternal({ kind: 'session', workspaceId, sessionId, platform })
  }

  /**
   * 签发一个 workspace-超级群配对码。用于一次性设置流程 ——
   * 当用户在超级群里输入 `/pair <code>` 时，捕获该 Telegram 超级群的 chat_id。
   */
  generateForSupergroup(workspaceId: string, platform: PlatformType): GeneratedPairing {
    return this.generateInternal({ kind: 'workspace-supergroup', workspaceId, platform })
  }

  private generateInternal(args: {
    kind: PairingKind
    workspaceId: string
    sessionId?: string
    platform: PlatformType
  }): GeneratedPairing {
    this.checkRate(args.workspaceId)
    this.gc()

    // 抗碰撞：如果与一个存活中的配对码撞了，就重试几次。
    let code = this.randomCode()
    for (let i = 0; i < 5 && this.entries.has(this.key(args.platform, code)); i++) {
      code = this.randomCode()
    }

    const expiresAt = Date.now() + this.ttlMs
    this.entries.set(this.key(args.platform, code), {
      kind: args.kind,
      workspaceId: args.workspaceId,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      platform: args.platform,
      code,
      expiresAt,
    })
    return { code, expiresAt }
  }

  /**
   * 消费一个配对码。返回一次条目后删除。
   * 未知、过期或 workspace 不匹配时返回 null。
   */
  consume(workspaceId: string, platform: PlatformType, code: string): PairingEntry | null {
    const entry = this.entries.get(this.key(platform, code))
    if (!entry) return null
    if (entry.workspaceId !== workspaceId) return null
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(this.key(platform, code))
      return null
    }
    this.entries.delete(this.key(platform, code))
    return entry
  }

  /** 作废某个 workspace 的所有配对码。平台断开时使用。 */
  clearWorkspace(workspaceId: string): void {
    for (const [k, v] of this.entries) {
      if (v.workspaceId === workspaceId) this.entries.delete(k)
    }
  }

  /**
   * 针对单个发送方的 `/pair` 尝试限流。在入口处计数，而不是在校验之后 ——
   * 否则猜错的成本为零，限流形同虚设。发送方身份始终以
   * workspaceId+platform 作作用域，避免泄露的 senderId 跨 workspace 串扰。
   *
   * 返回 `true` 表示调用方可以再尝试一次 consume，`false` 表示已到每分钟上限。
   */
  canConsume(workspaceId: string, platform: PlatformType, senderId: string): boolean {
    const key = `${workspaceId}:${platform}:${senderId}`
    const now = Date.now()
    const bucket = this.consumeBuckets.get(key)
    if (!bucket || now - bucket.windowStart > 60_000) {
      this.consumeBuckets.set(key, { windowStart: now, count: 1 })
      return true
    }
    if (bucket.count >= this.consumeRatePerMinute) return false
    bucket.count += 1
    return true
  }

  // -------------------------------------------------------------------------

  private key(platform: PlatformType, code: string): string {
    return `${platform}:${code}`
  }

  private randomCode(): string {
    // 6 位十进制数字，前补零
    return randomInt(0, 1_000_000).toString().padStart(6, '0')
  }

  private checkRate(workspaceId: string): void {
    const now = Date.now()
    const bucket = this.buckets.get(workspaceId)
    if (!bucket || now - bucket.windowStart > 60_000) {
      this.buckets.set(workspaceId, { windowStart: now, count: 1 })
      return
    }
    if (bucket.count >= this.ratePerMinute) {
      const err = new Error('Pairing code rate limit exceeded')
      ;(err as Error & { code?: string }).code = 'RATE_LIMIT'
      throw err
    }
    bucket.count += 1
  }

  /** 清除过期条目。O(n)，但 n 很小（每个 workspace、5 分钟窗口）。 */
  private gc(): void {
    const now = Date.now()
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k)
    }
  }
}
