/**
 * Transfer RPC 分片传输处理器。
 *
 * 让大 payload 的 RPC 调用（例如 sessions:import、resources:import）可以拆成多条小的
 * WebSocket 消息传输，从而绕过 Cloudflare、nginx 等代理/隧道的单条消息大小限制。
 *
 * 协议流程：
 *   1. transfer:start  → 分配临时目录，返回 transferId
 *   2. transfer:chunk  → 多次把分片写入临时文件
 *   3. transfer:commit → 重组 payload、执行被延迟的 RPC、清理临时数据
 *   4. transfer:abort  → 客户端取消/失败时尽力清理
 */

// 本文件属于 Transfer RPC 模块，负责：大 Payload 分片传输。
// 业务背景：sessions:import、resources:import 等接口可能传输几十 MB 的 bundle，
// 而 Cloudflare/nginx 等代理对单条 WebSocket 消息大小有限制，因此需要把大 payload 拆成多片传输。
// 协议：start -> chunk（多次）-> commit -> abort（可选）。
// TS 提示：Map<K, V> 类似 Golang 的 map，但 key 可以是任意类型；这里用 Map 保存活跃传输状态。

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'

/** 活跃分片传输的状态。 */
interface TransferState {
  id: string
  dir: string
  ownerClientId: string
  totalBytes: number
  chunkCount: number
  received: Set<number>
  channel: string
  args: any[]
  largeArgIndex: number
  checksum?: string
  timer: ReturnType<typeof setTimeout> | null
}

// 分片传输默认超时：5 分钟
const DEFAULT_TRANSFER_TTL_MS = 5 * 60 * 1000

// 本 handler 负责注册的 RPC channel 列表
export const HANDLED_CHANNELS = [
  RPC_CHANNELS.transfer.START,
  RPC_CHANNELS.transfer.CHUNK,
  RPC_CHANNELS.transfer.COMMIT,
  RPC_CHANNELS.transfer.ABORT,
] as const

// 活跃传输状态表：transferId -> TransferState
const activeTransfers = new Map<string, TransferState>()
// 支持分片传输的目标 channel 注册表
const transferableHandlers = new Map<string, HandlerFn>()

// getTransferTtlMs：读取环境变量中的传输超时，取默认值兜底。
function getTransferTtlMs(): number {
  const raw = Number(process.env.CRAFT_TRANSFER_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRANSFER_TTL_MS
}

// cleanupTransfer：清理指定传输的临时目录和状态。
async function cleanupTransfer(transferId: string): Promise<void> {
  const transfer = activeTransfers.get(transferId)
  if (!transfer) return

  if (transfer.timer) {
    clearTimeout(transfer.timer)
    transfer.timer = null
  }
  activeTransfers.delete(transferId)

  try {
    if (existsSync(transfer.dir)) {
      await rm(transfer.dir, { recursive: true, force: true })
    }
  } catch {
    // 尽力清理，忽略错误
  }
}

// rescheduleTransferCleanup：重置传输 TTL 定时器。
function rescheduleTransferCleanup(transfer: TransferState): void {
  if (transfer.timer) clearTimeout(transfer.timer)
  transfer.timer = setTimeout(() => {
    console.warn(`[Transfer:server] TTL expired for transfer ${transfer.id} — cleaning up`)
    void cleanupTransfer(transfer.id)
  }, getTransferTtlMs())
}

// assertTransferOwner：校验当前 client 是否是传输发起者，防止跨 client 篡改。
function assertTransferOwner(ctx: RequestContext, transfer: TransferState): void {
  if (ctx.clientId !== transfer.ownerClientId) {
    throw new Error('Transfer owned by different client')
  }
}

// setTransferableHandler：把某个 channel 标记为支持分片传输，commit 时会调用该 handler。
export function setTransferableHandler(channel: string, handler: HandlerFn): void {
  transferableHandlers.set(channel, handler)
}

// __resetTransferStateForTests：测试专用，清空所有传输状态和 handler 注册。
export function __resetTransferStateForTests(): void {
  for (const transfer of activeTransfers.values()) {
    if (transfer.timer) clearTimeout(transfer.timer)
  }
  activeTransfers.clear()
  transferableHandlers.clear()
}

// registerTransferHandlers：注册分片传输 RPC 路由。
export function registerTransferHandlers(server: RpcServer): void {
  // transfer:start：分配临时目录，保存元数据，返回 transferId。
  server.handle(RPC_CHANNELS.transfer.START, async (ctx, opts: {
    totalBytes: number
    chunkCount: number
    channel: string
    args: any[]
    largeArgIndex: number
    checksum?: string
  }) => {
    if (!opts || typeof opts.chunkCount !== 'number' || opts.chunkCount < 1) {
      throw new Error('Invalid chunkCount')
    }
    if (typeof opts.totalBytes !== 'number' || opts.totalBytes < 0) {
      throw new Error('Invalid totalBytes')
    }
    if (!opts.channel || typeof opts.channel !== 'string') {
      throw new Error('Missing target channel')
    }
    if (!Array.isArray(opts.args)) {
      throw new Error('Missing deferred args')
    }
    if (!transferableHandlers.has(opts.channel)) {
      throw new Error(`Channel ${opts.channel} does not support chunked transfer`)
    }
    if (!Number.isInteger(opts.largeArgIndex) || opts.largeArgIndex < 0 || opts.largeArgIndex >= opts.args.length) {
      throw new Error('Invalid largeArgIndex')
    }

    const transferId = randomUUID()
    const dir = join(tmpdir(), `craft-transfer-${transferId}`)
    await mkdir(dir, { recursive: true })

    const transfer: TransferState = {
      id: transferId,
      dir,
      ownerClientId: ctx.clientId,
      totalBytes: opts.totalBytes,
      chunkCount: opts.chunkCount,
      received: new Set(),
      channel: opts.channel,
      args: opts.args,
      largeArgIndex: opts.largeArgIndex,
      checksum: opts.checksum,
      timer: null,
    }
    activeTransfers.set(transferId, transfer)
    rescheduleTransferCleanup(transfer)

    const totalMB = (opts.totalBytes / (1024 * 1024)).toFixed(1)
    console.log(`[Transfer:server] Started transfer ${transferId}: ${opts.chunkCount} chunks, ${totalMB}MB, channel: ${opts.channel}`)

    return { transferId }
  })

  // transfer:chunk：接收一个分片并写入临时文件。
  server.handle(RPC_CHANNELS.transfer.CHUNK, async (ctx, opts: {
    transferId: string
    index: number
    data: string
  }) => {
    const transfer = activeTransfers.get(opts.transferId)
    if (!transfer) {
      console.error(`[Transfer:server] Unknown transfer: ${opts.transferId}`)
      throw new Error(`Unknown transfer: ${opts.transferId}`)
    }
    assertTransferOwner(ctx, transfer)

    if (!Number.isInteger(opts.index) || opts.index < 0 || opts.index >= transfer.chunkCount) {
      throw new Error(`Invalid chunk index: ${opts.index}`)
    }
    if (typeof opts.data !== 'string' || opts.data.length === 0) {
      throw new Error('Missing chunk data')
    }

    const chunkPath = join(transfer.dir, `chunk-${String(opts.index).padStart(6, '0')}`)
    await writeFile(chunkPath, opts.data, 'utf-8')
    transfer.received.add(opts.index)
    rescheduleTransferCleanup(transfer)

    if ((opts.index + 1) % 10 === 0 || opts.index === transfer.chunkCount - 1) {
      console.log(`[Transfer:server] Received chunk ${opts.index + 1}/${transfer.chunkCount} for ${transfer.id.slice(0, 8)}`)
    }

    return { received: opts.index }
  })

  // transfer:commit：校验所有分片是否到齐，重组 payload，执行目标 handler，最后清理。
  server.handle(RPC_CHANNELS.transfer.COMMIT, async (ctx, opts: {
    transferId: string
  }) => {
    const transfer = activeTransfers.get(opts.transferId)
    if (!transfer) {
      console.error(`[Transfer:server] Commit failed — unknown transfer: ${opts.transferId}`)
      throw new Error(`Unknown transfer: ${opts.transferId}`)
    }
    assertTransferOwner(ctx, transfer)

    console.log(`[Transfer:server] Committing transfer ${transfer.id.slice(0, 8)}: ${transfer.received.size}/${transfer.chunkCount} chunks received`)

    if (transfer.received.size !== transfer.chunkCount) {
      const missing: number[] = []
      for (let i = 0; i < transfer.chunkCount; i++) {
        if (!transfer.received.has(i)) missing.push(i)
      }
      throw new Error(`Missing ${missing.length} chunk(s): [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}]`)
    }

    const buffers: Buffer[] = []
    for (let i = 0; i < transfer.chunkCount; i++) {
      const chunkPath = join(transfer.dir, `chunk-${String(i).padStart(6, '0')}`)
      const encoded = await readFile(chunkPath, 'utf-8')
      buffers.push(Buffer.from(encoded, 'base64'))
    }
    const reassembled = Buffer.concat(buffers)

    if (reassembled.length !== transfer.totalBytes) {
      await cleanupTransfer(transfer.id)
      throw new Error(`Payload size mismatch: expected ${transfer.totalBytes} bytes, got ${reassembled.length}`)
    }

    if (transfer.checksum) {
      const actual = createHash('sha256').update(reassembled).digest('hex')
      if (actual !== transfer.checksum) {
        console.error(`[Transfer:server] Checksum mismatch for ${transfer.id.slice(0, 8)}: expected ${transfer.checksum.slice(0, 12)}..., got ${actual.slice(0, 12)}...`)
        await cleanupTransfer(transfer.id)
        throw new Error(`Checksum mismatch: expected ${transfer.checksum.slice(0, 12)}..., got ${actual.slice(0, 12)}...`)
      }
      console.log(`[Transfer:server] Checksum verified: ${actual.slice(0, 12)}...`)
    }

    let payload: any
    try {
      payload = JSON.parse(reassembled.toString('utf-8'))
    } catch {
      await cleanupTransfer(transfer.id)
      throw new Error(`Failed to parse reassembled payload (${(reassembled.length / (1024 * 1024)).toFixed(1)}MB, ${transfer.chunkCount} chunks)`)
    }

    const handler = transferableHandlers.get(transfer.channel)
    if (!handler) {
      await cleanupTransfer(transfer.id)
      throw new Error(`No handler for channel: ${transfer.channel}`)
    }

    const reassembledMB = (reassembled.length / (1024 * 1024)).toFixed(1)
    console.log(`[Transfer:server] Reassembled ${reassembledMB}MB payload for ${transfer.channel} — executing handler`)

    const args = [...transfer.args]
    args[transfer.largeArgIndex] = payload

    await cleanupTransfer(transfer.id)

    try {
      const result = await handler(ctx, ...args)
      console.log(`[Transfer:server] Handler ${transfer.channel} completed successfully`)
      return result
    } catch (err) {
      console.error(`[Transfer:server] Handler ${transfer.channel} failed:`, err)
      throw err
    }
  })

  // transfer:abort：客户端取消传输，清理临时数据。
  server.handle(RPC_CHANNELS.transfer.ABORT, async (ctx, opts: { transferId: string }) => {
    const transfer = activeTransfers.get(opts.transferId)
    if (!transfer) {
      return { aborted: false }
    }
    assertTransferOwner(ctx, transfer)
    await cleanupTransfer(transfer.id)
    console.warn(`[Transfer:server] Transfer aborted by client: ${transfer.id.slice(0, 8)}`)
    return { aborted: true }
  })
}
