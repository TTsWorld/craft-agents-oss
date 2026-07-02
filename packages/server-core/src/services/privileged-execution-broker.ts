/**
 * 特权执行代理
 *
 * 文件职责：
 *   - 管理需要提升权限执行的命令的审批流程（创建请求、解析审批结果）。
 *   - 内置白名单策略：仅允许 brew cask install/upgrade 与 installer -pkg -target / 命令。
 *   - 对每一次创建、审批、拒绝、过期、哈希不匹配等事件写入审计日志（JSONL）。
 *   - 实际命令执行由后端工具执行路径负责，本类只负责“审批绑定”与“审计”。
 *
 * 安全设计：
 *   - commandHash 使用 SHA-256 计算，审批时需要校验 expectedCommandHash，
 *     防止请求创建后到审批前命令被篡改。
 *   - 请求有过期时间，默认 120 秒，避免长期挂起。
 *   - 审计日志追加到用户主目录下的 privileged-actions.jsonl，便于事后追溯。
 *
 * 与 Golang 的类比：
 *   - `Map<string, PendingPrivilegedRequest>` 类似 Golang 的 `map[string]*PendingPrivilegedRequest`，
 *     但 TS 的 Map 是独立类型，保留插入顺序，键可以是任意值。
 *   - `createHash('sha256')` 来自 Node.js crypto 模块，等价于 Golang 的 `sha256.New()`。
 *
 * TS 特性小记：
 *   - `interface A extends B` 是结构扩展；`PendingPrivilegedRequest` 继承了
 *     `PrivilegedExecutionRequest` 的所有字段并追加私有字段。
 *   - `void this.appendAudit(...)` 中的 `void` 是运算符，表示“忽略 Promise 返回值”，
 *     避免触发 @typescript-eslint/no-floating-promises。
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Logger } from '../runtime/platform'

/** 特权执行请求（对外暴露的结构） */
export interface PrivilegedExecutionRequest {
  requestId: string
  sessionId: string
  command: string
  commandHash: string
  reason?: string
  impact?: string
  approvalTtlSeconds: number
  createdAt: number
  expiresAt: number
}

/** 内部待审批请求，追加策略判定结果 */
interface PendingPrivilegedRequest extends PrivilegedExecutionRequest {
  policyAllowed: boolean
  policyReason?: string
}

/** 默认审批有效期：120 秒 */
const DEFAULT_APPROVAL_TTL_SECONDS = 120

/** 审计日志路径：~/.craft-agent/logs/privileged-actions.jsonl */
const AUDIT_LOG_PATH = join(homedir(), '.craft-agent', 'logs', 'privileged-actions.jsonl')

/**
 * 特权执行代理
 * 负责审批绑定、策略校验与审计；实际执行交给后端工具链。
 */
export class PrivilegedExecutionBroker {
  /** 待审批请求表：requestId → PendingPrivilegedRequest */
  private pending = new Map<string, PendingPrivilegedRequest>()

  constructor(private logger: Logger) {}

  /**
   * 创建特权执行请求。
   * @param input - 请求基本信息
   * @returns 创建的请求对象（含 commandHash 与过期时间）
   */
  createRequest(input: {
    requestId: string
    sessionId: string
    command: string
    reason?: string
    impact?: string
    approvalTtlSeconds?: number
  }): PrivilegedExecutionRequest {
    const now = Date.now()
    const ttl = input.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS
    const policy = this.validatePolicy(input.command)

    const request: PendingPrivilegedRequest = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      command: input.command,
      commandHash: this.hashCommand(input.command),
      reason: input.reason,
      impact: input.impact,
      approvalTtlSeconds: ttl,
      createdAt: now,
      expiresAt: now + ttl * 1000,
      policyAllowed: policy.allowed,
      policyReason: policy.reason,
    }

    this.pending.set(input.requestId, request)
    void this.appendAudit({
      event: 'privileged_request_created',
      requestId: request.requestId,
      sessionId: request.sessionId,
      commandHash: request.commandHash,
      command: request.command,
      policyAllowed: request.policyAllowed,
      policyReason: request.policyReason,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    })

    return request
  }

  /**
   * 解析审批结果。
   * 校验顺序：请求存在性 → commandHash 匹配 → 策略允许 → 是否过期 → 最终批准/拒绝。
   *
   * @param requestId - 请求 ID
   * @param approved - 用户是否批准
   * @param options.expectedCommandHash - 可选的 commandHash 校验值
   * @returns 审批结果；ok=true 时附带请求对象
   */
  resolveApproval(
    requestId: string,
    approved: boolean,
    options?: { expectedCommandHash?: string },
  ): {
    ok: boolean
    reason?: string
    request?: PrivilegedExecutionRequest
  } {
    const request = this.pending.get(requestId)
    if (!request) {
      return { ok: false, reason: 'No pending privileged request found' }
    }

    this.pending.delete(requestId)

    if (options?.expectedCommandHash && options.expectedCommandHash !== request.commandHash) {
      void this.appendAudit({
        event: 'privileged_request_hash_mismatch',
        requestId: request.requestId,
        sessionId: request.sessionId,
        expectedCommandHash: options.expectedCommandHash,
        actualCommandHash: request.commandHash,
      })
      return { ok: false, reason: 'Command hash mismatch for privileged approval request' }
    }

    if (!request.policyAllowed) {
      void this.appendAudit({
        event: 'privileged_request_blocked_by_policy',
        requestId: request.requestId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
        policyReason: request.policyReason,
      })
      return { ok: false, reason: request.policyReason ?? 'Command is not allowed by privileged policy' }
    }

    if (Date.now() > request.expiresAt) {
      void this.appendAudit({
        event: 'privileged_request_expired',
        requestId: request.requestId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
        expiresAt: request.expiresAt,
      })
      return { ok: false, reason: 'Privileged approval request expired' }
    }

    void this.appendAudit({
      event: approved ? 'privileged_request_approved' : 'privileged_request_denied',
      requestId: request.requestId,
      sessionId: request.sessionId,
      commandHash: request.commandHash,
      resolvedAt: Date.now(),
    })

    return {
      ok: true,
      request: {
        requestId: request.requestId,
        sessionId: request.sessionId,
        command: request.command,
        commandHash: request.commandHash,
        reason: request.reason,
        impact: request.impact,
        approvalTtlSeconds: request.approvalTtlSeconds,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      },
    }
  }

  /** 计算命令的 SHA-256 哈希，用于审批时防篡改校验 */
  private hashCommand(command: string): string {
    return createHash('sha256').update(command, 'utf8').digest('hex')
  }

  /**
   * 校验命令是否符合特权执行白名单策略。
   * 当前仅允许：
   *   - brew install --cask <...>
   *   - brew upgrade --cask <...>
   *   - installer -pkg <...> -target /
   */
  private validatePolicy(command: string): { allowed: boolean; reason?: string } {
    const normalized = command.trim().toLowerCase()
    const allowlisted =
      /^brew\s+install\s+--cask\s+/.test(normalized) ||
      /^brew\s+upgrade\s+--cask\s+/.test(normalized) ||
      /^installer\s+-pkg\s+.+\s+-target\s+\//.test(normalized)

    if (!allowlisted) {
      return {
        allowed: false,
        reason: 'Privileged execution policy only allows brew cask install/upgrade and installer -pkg -target / commands',
      }
    }

    return { allowed: true }
  }

  /**
   * 记录自定义审计事件。
   * @param event - 事件类型
   * @param payload - 事件负载
   */
  auditEvent(event: string, payload: Record<string, unknown>): void {
    void this.appendAudit({ event, ...payload })
  }

  /**
   * 向审计日志追加一条 JSONL 记录。
   * 自动创建父目录；写入失败时仅记录 warn，不影响主流程。
   */
  private async appendAudit(payload: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true })
      await appendFile(AUDIT_LOG_PATH, `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`, 'utf8')
    } catch (error) {
      this.logger.warn('[PrivilegedExecutionBroker] Failed to write audit log:', error)
    }
  }
}
