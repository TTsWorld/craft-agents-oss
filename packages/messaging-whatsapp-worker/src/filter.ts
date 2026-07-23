/**
 * filter.ts — WA Worker 的 `messages.upsert` 处理器使用的纯过滤辅助函数。
 *
 * 逻辑从 `worker.ts` 抽离成独立文件后，分类逻辑可以在不加载 worker 入口
 * （它会在模块加载时安装 stdin 和信号处理句柄）的情况下做单元测试。
 */

/**
 * 把 Baileys 的 JID 归一化，让 `sock.user.id`（可能带设备后缀，
 * 例如 `num:10@s.whatsapp.net`）能和自聊(self-chat)里 `key.remoteJid`
 * 使用的纯 `num@s.whatsapp.net` 形式相等比较。
 */
export function bareJid(jid: string | undefined | null): string | null {
  if (!jid) return null
  const at = jid.indexOf('@')
  if (at === -1) return jid
  const localPart = jid.slice(0, at)
  const colon = localPart.indexOf(':')
  if (colon === -1) return jid
  return localPart.slice(0, colon) + jid.slice(at)
}

/**
 * 从 Baileys 消息里提取可见文本。覆盖我们关心的内容类型子集：
 * 纯文本 conversation、extendedText，以及图片/文档/视频的 caption（说明文字）。
 */
export function extractText(msg: Record<string, unknown>): string {
  const m = msg.message as Record<string, unknown> | undefined
  if (!m) return ''
  const conv = m.conversation as string | undefined
  if (conv) return conv
  const ext = m.extendedTextMessage as Record<string, unknown> | undefined
  if (typeof ext?.text === 'string') return ext.text as string
  const img = m.imageMessage as Record<string, unknown> | undefined
  if (typeof img?.caption === 'string') return img.caption as string
  const doc = m.documentMessage as Record<string, unknown> | undefined
  if (typeof doc?.caption === 'string') return doc.caption as string
  const vid = m.videoMessage as Record<string, unknown> | undefined
  if (typeof vid?.caption === 'string') return vid.caption as string
  return ''
}

export interface ClassifyContext {
  selfChatMode: boolean
  responsePrefix: string
  /** 账号的纯号码 JID（无设备后缀），例如 `num@s.whatsapp.net`。 */
  selfJid: string | null
  /**
   * 账号的纯 LID 形式（无设备后缀），例如 `lid@lid`。
   * WhatsApp 较新的客户端即使在 `sock.user.id` 仍是号码 JID 时，
   * 也可能以 LID 形式投递自聊的 `key.remoteJid`，因此自聊判定必须同时接受两者。
   */
  selfLid: string | null
  sentIds: Set<string>
}

export type InboundDecision =
  | { action: 'emit'; text: string }
  | {
      action: 'skip'
      reason:
        | 'malformed'
        | 'own_echo_id'
        | 'own_echo_prefix'
        | 'own_outbound'
        | 'non_self_chat_inbound'
        | 'empty'
    }

/**
 * 当 `remoteJid` 是账号的自聊会话时返回 true（与号码 JID 和 LID 形式比较，
 * 两者都已剥离设备后缀）。
 */
function isSelfChatJid(
  remoteJid: string,
  selfJid: string | null,
  selfLid: string | null,
): boolean {
  const bareRemote = bareJid(remoteJid)
  if (bareRemote === null) return false
  if (selfJid !== null && bareRemote === selfJid) return true
  if (selfLid !== null && bareRemote === selfLid) return true
  return false
}

/**
 * 判定如何处理单条 upsert 消息。
 *
 * `selfChatMode` 的语义：「只在账号的自聊会话里工作。」
 * 两个方向对称地做门控——非自聊时，其他设备的出站消息和联系人的入站消息都会被丢弃。
 *
 * `fromMe=true` 时的判定优先级：
 *   1. id 在 sentIds 中      → 跳过（我们自己的回声，第一道防线）
 *   2. 非自聊                 → 跳过（用户在普通会话里的出站）
 *   3. 匹配前缀               → 跳过（回声兜底防线）
 *   4. 空文本                 → 跳过
 *   5. 其他                   → 上报（手机/桌面端在自聊里输入的内容）
 *
 * `fromMe=false` 时：
 *   1. selfChatMode 开启且非自聊 → 跳过（联系人/群组给我们发消息）
 *   2. 空文本                     → 跳过
 *   3. 其他                       → 上报
 */
export function classifyInbound(
  msg: Record<string, unknown>,
  ctx: ClassifyContext,
): InboundDecision {
  const key = msg.key as { remoteJid?: string; fromMe?: boolean; id?: string } | undefined
  if (!key || !key.remoteJid || !key.id) return { action: 'skip', reason: 'malformed' }

  const text = extractText(msg)
  const inSelfChat = isSelfChatJid(key.remoteJid, ctx.selfJid, ctx.selfLid)

  if (key.fromMe) {
    if (ctx.sentIds.has(key.id)) return { action: 'skip', reason: 'own_echo_id' }

    if (!ctx.selfChatMode || !inSelfChat) return { action: 'skip', reason: 'own_outbound' }

    if (ctx.responsePrefix && text.startsWith(ctx.responsePrefix)) {
      return { action: 'skip', reason: 'own_echo_prefix' }
    }

    if (!text) return { action: 'skip', reason: 'empty' }
    return { action: 'emit', text }
  }

  if (ctx.selfChatMode && !inSelfChat) {
    return { action: 'skip', reason: 'non_self_chat_inbound' }
  }

  if (!text) return { action: 'skip', reason: 'empty' }
  return { action: 'emit', text }
}

/** 限制 sent-ID 集合大小，避免长时间运行的会话泄漏内存。 */
export const MAX_SENT_IDS = 500

/**
 * 将 `id` 插入有界 sent-ID 集合。`Set` 保持插入顺序，
 * 因此最旧的条目就是 `values().next().value`——在溢出时淘汰它。
 */
export function rememberSentId(sentIds: Set<string>, id: string): void {
  sentIds.add(id)
  if (sentIds.size > MAX_SENT_IDS) {
    const oldest = sentIds.values().next().value
    if (oldest !== undefined) sentIds.delete(oldest)
  }
}
