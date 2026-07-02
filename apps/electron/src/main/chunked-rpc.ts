/**
 * chunked-rpc.ts —— 分片 RPC 传输。
 *
 * 把单个大型 RPC 参数拆成 base64 小片（每片约 2.7MB），通过
 * transfer:start/chunk/commit 协议发送，远端服务器再拼装并执行原始 handler。
 *
 * 每片失败时最多重试 3 次，以应对代理/隧道等瞬断问题。
 */

import { createHash } from 'node:crypto'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { WsRpcClient } from '../transport/client'

/**
 * 原始 2MB → base64 后约 2.7MB。
 * 片越大往返次数越少（250MB 载荷约 125 片而非 651 片），
 * 但仍低于常见代理的单消息限制。
 */
export const CHUNK_SIZE = 2 * 1024 * 1024

/** 超过此阈值就从直接 RPC 切换到分片传输 */
export const CHUNKED_TRANSFER_THRESHOLD = 5 * 1024 * 1024

/** 每片最大重试次数 */
const MAX_CHUNK_RETRIES = 3

/** 分片重试间隔（毫秒） */
const CHUNK_RETRY_DELAY = 1000

// 预序列化后的分片载荷信息
export interface PreparedChunkedPayload {
  bytes: Buffer
  checksum: string
  chunkCount: number
}

export function getChunkCount(totalBytes: number): number {
  return Math.ceil(totalBytes / CHUNK_SIZE)
}

export function prepareChunkedPayload(value: unknown): PreparedChunkedPayload {
  const json = JSON.stringify(value)
  const bytes = Buffer.from(json, 'utf-8')
  return {
    bytes,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    chunkCount: getChunkCount(bytes.length),
  }
}

/**
 * 通过已有 WebSocket 连接发送大型 RPC 调用。
 *
 * @param client         已连接到远端服务器的 WsRpcClient
 * @param channel        原始 RPC channel，例如 'sessions:import'
 * @param args           原始参数数组
 * @param largeArgIndex  哪个参数是大载荷（会被分片替换为 null 占位）
 * @param onProgress     可选进度回调 (sentChunks, totalChunks)
 * @param prepared       可选预序列化载荷，避免调用方重复序列化
 * @returns              远端 handler 的执行结果，与直接 invoke 等价
 */
export async function invokeChunked(
  client: WsRpcClient,
  channel: string,
  args: any[],
  largeArgIndex: number,
  onProgress?: (sent: number, total: number) => void,
  prepared?: PreparedChunkedPayload,
): Promise<any> {
  const payload = prepared ?? prepareChunkedPayload(args[largeArgIndex])

  // 构造延迟参数：把大参数替换成 null 占位，等大块数据传输后再在服务端还原
  const deferredArgs = [...args]
  deferredArgs[largeArgIndex] = null

  const payloadMB = (payload.bytes.length / (1024 * 1024)).toFixed(1)
  console.log(`[ChunkedRPC] Starting transfer: ${payload.chunkCount} chunks, ${payloadMB}MB, sha256: ${payload.checksum.slice(0, 12)}..., channel: ${channel}`)

  let transferId: string | null = null
  try {
    const startResult = await client.invoke(RPC_CHANNELS.transfer.START, {
      totalBytes: payload.bytes.length,
      chunkCount: payload.chunkCount,
      channel,
      args: deferredArgs,
      largeArgIndex,
      checksum: payload.checksum,
    }) as { transferId: string }

    transferId = startResult.transferId
    console.log(`[ChunkedRPC] Transfer started: ${transferId}`)

    for (let i = 0; i < payload.chunkCount; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, payload.bytes.length)
      const data = payload.bytes.subarray(start, end).toString('base64')

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        try {
          await client.invoke(RPC_CHANNELS.transfer.CHUNK, {
            transferId,
            index: i,
            data,
          })
          lastError = null
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (attempt < MAX_CHUNK_RETRIES) {
            console.warn(`[ChunkedRPC] Chunk ${i + 1}/${payload.chunkCount} failed (attempt ${attempt}/${MAX_CHUNK_RETRIES}): ${lastError.message}. Retrying in ${CHUNK_RETRY_DELAY}ms...`)
            await new Promise(r => setTimeout(r, CHUNK_RETRY_DELAY))
          }
        }
      }

      if (lastError) {
        throw new Error(`Chunk ${i + 1}/${payload.chunkCount} failed after ${MAX_CHUNK_RETRIES} attempts: ${lastError.message}`)
      }

      onProgress?.(i + 1, payload.chunkCount)

      if ((i + 1) % 10 === 0 || i === payload.chunkCount - 1) {
        console.log(`[ChunkedRPC] Sent chunk ${i + 1}/${payload.chunkCount}`)
      }
    }

    console.log('[ChunkedRPC] All chunks sent, committing...')
    const result = await client.invoke(RPC_CHANNELS.transfer.COMMIT, { transferId })
    console.log('[ChunkedRPC] Transfer committed successfully')
    transferId = null
    return result
  } catch (error) {
    if (transferId) {
      try {
        await client.invoke(RPC_CHANNELS.transfer.ABORT, { transferId })
      } catch {
        // 尽力清理：服务端可能已经清理掉了，忽略错误
      }
    }
    throw error
  }
}
