/**
 * format.ts — Markdown → Telegram MarkdownV2 格式化。
 *
 * Telegram MarkdownV2 要求对代码块外的特殊字符做转义。
 * Phase 1 发送纯文本——格式化在 Phase 2 加入。
 */

/** Telegram MarkdownV2 中必须转义的字符。 */
const TG_SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g

/** 为 Telegram MarkdownV2 parse mode 转义文本。 */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(TG_SPECIAL_CHARS, '\\$1')
}

/**
 * Phase 1 发送纯文本（不带 parse_mode）。
 * 这样可以避免转义问题，先验证核心流程。
 */
export function formatForTelegram(text: string): string {
  return text
}
