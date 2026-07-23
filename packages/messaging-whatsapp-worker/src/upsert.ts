/**
 * WA Worker 的 `messages.upsert` 监听器使用的逐消息 upsert 处理管线。
 *
 * 抽离成独立模块后，单元测试可以直接驱动它，而无需 import `worker.ts`
 * （后者顶层会安装 stdin / 信号处理句柄）。
 */

import { bareJid, classifyInbound } from './filter'
import { extractAttachments } from './media'
import type { BaileysModule } from './worker'
import type { IncomingEvent } from './protocol'

export interface UpsertSession {
  selfChatMode: boolean
  responsePrefix: string
  sentIds: Set<string>
  baileys: BaileysModule
}

export interface UpsertContext {
  cutoff: number
  selfJid: string | null
  selfLid: string | null
}

export type EmitFn = (event: IncomingEvent) => void
export type LogFn = (...args: unknown[]) => void

/**
 * 处理单条 upsert 消息：历史过滤 → 分类 → 媒体提取 → 上报。
 *
 * 判定优先级：
 * - 历史（时间戳早于 `cutoff`）→ 静默跳过
 * - classifyInbound → 处理 malformed / own_echo_id / own_outbound /
 *   non_self_chat_inbound / own_echo_prefix，返回 `emit { text }` 或
 *   `skip { reason }`。任何非 `empty` 的跳过在此同样生效——我们不会因为
 *   自己的出站消息带媒体就改判为上报。
 * - 唯一的覆盖场景是 `skip { reason: 'empty' }`：语音消息没有 caption，
 *   所以空文本 + 媒体时仍需上报。
 */
export async function processUpsertMessage(
  msg: Record<string, unknown>,
  upsertCtx: UpsertContext,
  session: UpsertSession,
  emit: EmitFn,
  log: LogFn,
): Promise<void> {
  const ts = Number((msg as { messageTimestamp?: unknown }).messageTimestamp)
  if (Number.isFinite(ts) && ts > 0 && ts < upsertCtx.cutoff) {
    log(`upsert skip: history (ts=${ts} cutoff=${upsertCtx.cutoff})`)
    return
  }

  // 调试上下文：把 classifyInbound 依赖的精确信号暴露出来，
  // 方便定位静默跳过的场景（'own_outbound'、'empty'）。
  const dbgKey = (msg.key ?? {}) as {
    remoteJid?: string
    fromMe?: boolean
    id?: string
  }
  const msgKeys = msg.message
    ? Object.keys(msg.message as Record<string, unknown>).join(',')
    : '<no message>'
  log(
    `upsert msg fromMe=${!!dbgKey.fromMe} remoteJid=${dbgKey.remoteJid ?? '?'} ` +
      `selfJid=${upsertCtx.selfJid ?? '?'} selfLid=${upsertCtx.selfLid ?? '?'} ` +
      `bareRemote=${bareJid(dbgKey.remoteJid) ?? '?'} msgKeys=${msgKeys}`,
  )

  const decision = classifyInbound(msg, {
    selfChatMode: session.selfChatMode,
    responsePrefix: session.responsePrefix,
    selfJid: upsertCtx.selfJid,
    selfLid: upsertCtx.selfLid,
    sentIds: session.sentIds,
  })

  if (decision.action === 'skip' && decision.reason !== 'empty') {
    log(`upsert skip: ${decision.reason}`)
    return
  }

  const attachments = await extractAttachments(session.baileys, msg, log)
  const text = decision.action === 'emit' ? decision.text : ''

  if (decision.action === 'skip' && attachments.length === 0) {
    log('upsert skip: empty')
    return
  }

  const key = msg.key as { remoteJid?: string; id?: string }
  log(
    `upsert emit: channelId=${key.remoteJid} textLen=${text.length} attachments=${attachments.length}`,
  )
  emit({
    type: 'incoming',
    channelId: key.remoteJid!,
    messageId: key.id!,
    senderId: key.remoteJid!,
    senderName: (msg.pushName as string | undefined) ?? undefined,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
  })
}
