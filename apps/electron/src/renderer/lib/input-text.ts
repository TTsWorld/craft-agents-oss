/**
 * 把不可信的 composer/draft 输入值强制转换为纯文本字符串。
 *
 * 渲染进程通常把 draft 文本存为 string，但已安装版本可能遇到陈旧或损坏的持久化值
 *（例如整个 draft 对象，或 `text` 字段里是个对象）。
 * 在调用 `.trim()` 或富文本渲染前先做防御性转换，避免非字符串值导致报错。
 */
export function coerceInputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof String) return value.toString()

  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }

  return ''
}

/**
 * 把现有输入草稿与需要恢复的文本合并（例如点击 Stop 后把最后一条用户消息塞回输入框）。
 * 中间加一行空行，避免正在输入的草稿被直接覆盖；若其中一侧为空，则直接返回另一侧。
 */
export function appendRestoredInput(existing: string | undefined, restored: string | undefined): string {
  const existingText = coerceInputText(existing)
  const restoredText = coerceInputText(restored)
  if (!restoredText) return existingText
  return existingText ? `${existingText}\n\n${restoredText}` : restoredText
}
