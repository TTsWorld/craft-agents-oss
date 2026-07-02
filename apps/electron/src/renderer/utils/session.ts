/**
 * session.ts — 会话（Session）相关工具函数
 *
 * 所属目录：renderer/utils
 * 运行环境：Electron 的 renderer（渲染）进程。本文件只做纯数据与展示层计算，
 *         不直接读写文件或网络；这类操作由 main 进程负责。
 * 作用：
 *   - 从会话元数据或完整会话对象生成标题、预览文本
 *   - 判断未读消息、统计未读数量
 *   - 提供相对时间本地化与搜索高亮等展示层辅助
 *
 * 基本概念：
 *   - Session：一次完整的 AI 对话，包含多条 Message。
 *   - SessionMeta：轻量化的会话摘要，通常用于会话列表，不加载全部消息。
 *   - Message：单条消息，role 可为 'user'、'assistant'、'plan' 等。
 *   - isIntermediate：标记是否为中间状态消息（例如思考过程），不计入最终回复。
 */
import * as React from "react"
import i18next from "i18next"
import type { Session, Message } from "../../shared/types"
import type { SessionMeta } from "../atoms/sessions"
import type { SessionStatusId } from "../config/session-status-config"

// 用于 getSessionTitle 的最小会话字段集合
// Pick<Session, 'name' | 'preview'> 表示从 Session 类型中只取出 name 与 preview 两个字段
type SessionLike = Pick<Session, 'name' | 'preview'> & { messages?: Session['messages'] }

/**
 * 清理用作会话标题的内容。
 * - 去掉 <edit_request>...</edit_request> 等 XML 块
 * - 去掉剩余 HTML/XML 标签
 * - 折叠连续空白
 */
function sanitizePreview(content: string): string {
  return content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // 移除完整的 edit_request 块
    .replace(/<[^>]+>/g, '')     // 移除剩余标签
    .replace(/\s+/g, ' ')        // 将多个空白合并为一个空格
    .trim()
}

/**
 * 修正标题首字母被错误大写的 URL scheme。
 * 例如 "Https://example.com" 会被还原为 "https://example.com"。
 * 如果标题不以已知 scheme 开头，则原样返回（幂等）。
 */
function normalizeTitleCasing(title: string): string {
  return title.replace(/^(https?|mailto|file|ftp):/i, (m) => m.toLowerCase())
}

/**
 * 获取会话的展示标题。
 * 优先级：自定义名称 > 第一条用户消息 > preview 字段 > 默认文案 "New chat"
 * 同时兼容完整 Session 对象与轻量的 SessionMeta。
 */
export function getSessionTitle(session: SessionLike | SessionMeta): string {
  if (session.name) {
    return normalizeTitleCasing(session.name)
  }

  // 优先从已加载的消息中查找（仅完整 Session 才有 messages）
  if ('messages' in session && session.messages) {
    const firstUserMessage = session.messages.find(m => m.role === 'user')
    if (firstUserMessage?.content) {
      const sanitized = sanitizePreview(firstUserMessage.content)
      if (sanitized) {
        const trimmed = sanitized.slice(0, 50)
        const truncated = trimmed.length < sanitized.length ? trimmed + '…' : trimmed
        return normalizeTitleCasing(truncated)
      }
    }
  }

  // 退而求其次，使用 JSONL 头部或 SessionMeta 中的 preview（懒加载场景）
  if (session.preview) {
    const sanitized = sanitizePreview(session.preview)
    if (sanitized) {
      const trimmed = sanitized.slice(0, 50)
      const truncated = trimmed.length < sanitized.length ? trimmed + '…' : trimmed
      return normalizeTitleCasing(truncated)
    }
  }

  return i18next.t('session.defaultTitle', 'New chat')
}

/**
 * 为会话列表生成一行紧凑的预览文本。
 * 优先使用 preview 或第一条用户消息，但避免与标题重复。
 */
export function getSessionPreviewText(session: SessionLike | SessionMeta, maxLength = 88): string | null {
  const source = session.preview
    || (('messages' in session && session.messages)
      ? session.messages.find(m => m.role === 'user')?.content
      : undefined)

  if (!source) return null

  const sanitized = sanitizePreview(source)
  if (!sanitized) return null

  const title = getSessionTitle(session).replace(/…$/, '').trim()
  const normalizedTitle = sanitizePreview(title)
  if (normalizedTitle) {
    const sanitizedLower = sanitized.toLowerCase()
    const titleLower = normalizedTitle.toLowerCase()
    // 如果预览与标题完全一致，则无需再显示预览
    if (sanitizedLower === titleLower) {
      return null
    }
    // 若预览以标题开头，去掉标题前缀，保留后面的内容
    // 例："https://… Analyze the article" → "Analyze the article"
    if (sanitizedLower.startsWith(titleLower)) {
      let remainder = sanitized.slice(normalizedTitle.length)
      // 如果标题在截断处正好切在某个 token 中间（如 URL 中段），
      // 继续吞掉剩余的 token，避免预览以 "alyze the feature" 这种残缺词开头。
      const titleEnd = sanitized.charAt(normalizedTitle.length - 1)
      const remainderHead = remainder.charAt(0)
      if (titleEnd && remainderHead && /\S/.test(titleEnd) && /\S/.test(remainderHead)) {
        const partialToken = remainder.match(/^\S+/)
        if (partialToken) {
          remainder = remainder.slice(partialToken[0].length)
        }
      }
      remainder = remainder.replace(/^[\s\-–—:|·•]+/, '').trim()
      if (!remainder) return null
      const trimmed = remainder.slice(0, maxLength)
      return trimmed.length < remainder.length ? `${trimmed.trimEnd()}…` : trimmed
    }
  }

  const trimmed = sanitized.slice(0, maxLength)
  return trimmed.length < sanitized.length ? `${trimmed.trimEnd()}…` : trimmed
}

/**
 * 获取最后一条“最终”的助手/计划消息 ID。
 * 排除中间状态消息（isIntermediate），用于未读消息追踪。
 */
export function getLastFinalAssistantMessageId(session: Session): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]
    // plan 消息也是 AI 生成的内容，视为最终回复
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate) {
      return msg.id
    }
  }
  return undefined
}

/**
 * 判断会话是否存在未读消息。
 * 条件：存在最终助手消息，且其 ID 与 lastReadMessageId 不一致。
 */
export function hasUnreadMessages(session: Session): boolean {
  const lastFinalId = getLastFinalAssistantMessageId(session)
  if (!lastFinalId) return false  // 还没有最终助手消息
  return lastFinalId !== session.lastReadMessageId
}

/**
 * 统计未读的最终助手/计划消息数量。
 * 返回 lastReadMessageId 之后的最终消息条数。
 */
export function countUnreadMessages(session: Session): number {
  // 局部辅助：判断一条消息是否为最终回复
  const isFinalResponse = (msg: Message) =>
    (msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate

  if (!session.lastReadMessageId) {
    // 从未读过，统计全部最终消息
    return session.messages.filter(isFinalResponse).length
  }

  // 找到上次已读消息的位置
  const lastReadIndex = session.messages.findIndex(msg => msg.id === session.lastReadMessageId)
  if (lastReadIndex === -1) {
    // 上次已读消息找不到了，按全部未读处理
    return session.messages.filter(isFinalResponse).length
  }

  // 只统计已读位置之后的最终消息
  let count = 0
  for (let i = lastReadIndex + 1; i < session.messages.length; i++) {
    if (isFinalResponse(session.messages[i])) {
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// SessionMeta 辅助函数（轻量，不需要完整 Session）
// ---------------------------------------------------------------------------

/** 获取会话的当前状态 ID，缺省返回 'todo' */
export function getSessionStatus(session: SessionMeta): SessionStatusId {
  return (session.sessionStatus as SessionStatusId) || 'todo'
}

/** 根据 SessionMeta 判断是否有未读消息 */
export function hasUnreadMeta(session: SessionMeta): boolean {
  return session.hasUnread === true
}

/** 根据 SessionMeta 判断会话是否已有最终消息 */
export function hasMessagesMeta(session: SessionMeta): boolean {
  return session.lastFinalMessageId !== undefined
}

// ---------------------------------------------------------------------------
// 展示层辅助函数
// ---------------------------------------------------------------------------

/**
 * 供 date-fns formatDistanceToNowStrict 使用的紧凑时间本地化对象。
 * 输出形如 "7m"、"2h"、"3d"、"2w"、"5mo"、"1y" 的字符串。
 * 通过 i18n key（time.compact.*）实现多语言适配。
 */
export const shortTimeLocale = {
  formatDistance: (token: string, count: number) => {
    const tokenToKey: Record<string, string> = {
      xSeconds: 'time.compact.seconds',
      xMinutes: 'time.compact.minutes',
      xHours: 'time.compact.hours',
      xDays: 'time.compact.days',
      xWeeks: 'time.compact.weeks',
      xMonths: 'time.compact.months',
      xYears: 'time.compact.years',
    }
    const key = tokenToKey[token]
    return key ? i18next.t(key, { count }) : `${count}`
  },
}

/**
 * 在文本中高亮匹配 query 的部分，返回 React 节点。
 * 匹配部分会被包裹在半透明白色背景的 span 中。
 */
export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)

  if (index === -1) return text

  const before = text.slice(0, index)
  const match = text.slice(index, index + query.length)
  const after = text.slice(index + query.length)

  return React.createElement(React.Fragment, null,
    before,
    React.createElement('span', { className: 'bg-yellow-300/30 rounded-[2px]' }, match),
    highlightMatch(after, query),
  )
}
