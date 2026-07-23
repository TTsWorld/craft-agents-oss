/**
 * PlanTokenRegistry —— 用于计划批准按钮的短寿命不透明 token。
 *
 * Telegram 的 `callback_data` 上限是 64 字节，太小，无法完整往返一个
 * 绝对 plan path。我们为每次计划提交签发一个 8 字符随机 token，
 * 在按钮 id 里以 `plan:accept:<token>` 形式下发，回调触发时再查回真实的
 * `{bindingId, sessionId, planPath}`。
 *
 * token 在 `ttlMs`（默认 30 分钟）后过期 —— 陈旧按钮解析为 `null`，
 * gateway 回复「plan 已过期，请从 desktop app 重试」。
 *
 * 撤销以 `bindingId` 为键，而不是 `sessionId`。一个 session 若有两个
 * Telegram binding，就会有两个*相互独立*的存活 token —— 每个聊天一个 ——
 * 在某个 binding 上签发新计划只会使该 binding 上一个 token 失效。
 * 旧的按 session 作用域的撤销方式会在任一 binding 渲染新计划时
 * 悄悄废掉所有其他 binding 的按钮。
 */

import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 30 * 60 * 1000

export interface PlanTokenEntry {
  bindingId: string
  sessionId: string
  planPath: string
  messageId?: string
  createdAt: number
}

export class PlanTokenRegistry {
  private readonly tokens = new Map<string, PlanTokenEntry>()
  private readonly ttlMs: number

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  issue(
    bindingId: string,
    sessionId: string,
    planPath: string,
    messageId?: string,
  ): string {
    // 仅取代该 binding 上一个计划。同一 session 下的兄弟 binding
    // 保留自己存活的 token。
    this.revokeForBinding(bindingId)
    const token = randomBytes(6).toString('base64url').slice(0, 8)
    this.tokens.set(token, {
      bindingId,
      sessionId,
      planPath,
      messageId,
      createdAt: Date.now(),
    })
    return token
  }

  resolve(token: string): PlanTokenEntry | null {
    const entry = this.tokens.get(token)
    if (!entry) return null
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.tokens.delete(token)
      return null
    }
    return entry
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }

  revokeForBinding(bindingId: string): void {
    for (const [token, entry] of this.tokens) {
      if (entry.bindingId === bindingId) this.tokens.delete(token)
    }
  }

  size(): number {
    return this.tokens.size
  }
}
