/**
 * ChatDisplay.follow-ups - 跟进批注（follow-up annotations）的纯工具函数。
 *
 * 单独抽离的原因：方便单元测试，不需要引入 React 或整个渲染层。
 * ChatDisplay.tsx 会重新导入这些函数，不要在那里重复实现。
 *
 * 这里有两套不同的处理：
 *   - normalizeFollowUpText（从 @craft-agent/ui 重导出）：保留内容、只折叠空白，
 *     用于发给 agent 的消息，不限制长度。
 *   - truncateForChipTooltip：UI 辅助函数，给芯片序号徽章的 hover tooltip 做截断省略。
 *     调用方必须显式传入上限；不要设置默认值——曾经因此出过 bug（OSS #580），
 *     agent 消息路径误用了带默认值的截断函数。
 */

import { normalizeFollowUpText } from '@craft-agent/ui/annotations/follow-up-state'

/** PendingFollowUpAnnotation：待发送的 follow-up 批注数据 */
export type PendingFollowUpAnnotation = {
  messageId: string
  annotationId: string
  note: string
  selectedText: string
  createdAt: number
  color?: string
  meta?: Record<string, unknown>
}

/**
 * truncateForChipTooltip - 折叠空白并对芯片 tooltip 文本做截断省略。
 * 不要用于发给 agent 的消息；那种场景直接用 normalizeFollowUpText，保证 agent 看到完整引用。
 */
export function truncateForChipTooltip(text: string, maxLength: number): string {
  const normalized = normalizeFollowUpText(text)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

/**
 * formatFollowUpSection - 把待发送的 follow-up 批注格式化为 markdown 区块，
 * 追加到用户消息里再发给 agent。引用原文完整保留，只规范化空白，
 * 这样消息编辑时的往返解析器（normalizeFollowUpsMarkdown）能正确还原。
 */
export function formatFollowUpSection(
  followUps: PendingFollowUpAnnotation[],
  options?: { includeTopSeparator?: boolean },
): string {
  if (followUps.length === 0) return ''

  const includeTopSeparator = options?.includeTopSeparator ?? true

  const items = followUps.map((followUp, idx) => {
    const quoteText = normalizeFollowUpText(followUp.selectedText)
    return [
      `> [#${idx + 1}] ${quoteText}`,
      `→ ${followUp.note}`,
    ].join('\n')
  })

  const body = ['**Follow-ups**', items.join('\n\n---\n\n')].join('\n\n')
  return includeTopSeparator ? `---\n\n${body}` : body
}

/**
 * normalizeFollowUpsMarkdown - 重新解析已包含 **Follow-ups** 区块的消息，
 * 并以规范形式重建。用户编辑已发送消息时使用，用于：
 * 规范化空白、重新编号、修复间距，同时不丢失 quote/note 对。
 *
 * 正则使用懒惰匹配 [\s\S]*?，因此任意长的引用都能正确处理。
 * quote 和 note 里的空白会被折叠，和 normalizeFollowUpText 输出一致，
 * 所以 formatFollowUpSection 生成的内容再经过本函数处理应为 no-op。
 */
export function normalizeFollowUpsMarkdown(message: string): string {
  const normalizedInput = message.replace(/\r\n/g, '\n')
  const headingMatch = /(?:\*\*Follow-ups\*\*|Follow-up annotations:)/i.exec(normalizedInput)
  if (!headingMatch || headingMatch.index == null) return message

  const headingIndex = headingMatch.index
  const beforeHeading = normalizedInput.slice(0, headingIndex).trimEnd()
  const hasTrailingSeparator = /(?:^|\n)\s*---\s*$/.test(beforeHeading)
  const sectionText = normalizedInput.slice(headingIndex)

  // 去掉标题和可选的前导分隔符，方便解析每一项
  const body = sectionText
    .replace(/^\s*(?:---\s*)?(?:\*\*Follow-ups\*\*|Follow-up annotations:)\s*/i, '')

  const itemRegex = />?\s*\[#(\d+)\]\s*([\s\S]*?)\s*→\s*([\s\S]*?)(?=(?:\s*---\s*>?\s*\[#\d+\])|$)/g
  const parsedItems: Array<{ quote: string; note: string }> = []

  for (const match of body.matchAll(itemRegex)) {
    const quote = match[2]?.replace(/\s+/g, ' ').trim()
    const note = match[3]?.replace(/\s+/g, ' ').trim()
    if (!quote || !note) continue
    parsedItems.push({ quote, note })
  }

  if (parsedItems.length === 0) {
    return message
  }

  const rebuiltItems = parsedItems.map((item, idx) => [
    `> [#${idx + 1}] ${item.quote}`,
    `→ ${item.note}`,
  ].join('\n'))

  const includeTopSeparator = beforeHeading.length > 0 && !hasTrailingSeparator
  const rebuiltBody = ['**Follow-ups**', rebuiltItems.join('\n\n---\n\n')].join('\n\n')
  const rebuiltSection = includeTopSeparator
    ? `---\n\n${rebuiltBody}`
    : rebuiltBody

  return beforeHeading.length > 0 ? `${beforeHeading}\n\n${rebuiltSection}` : rebuiltSection
}
