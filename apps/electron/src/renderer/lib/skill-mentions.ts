/**
 * @deprecated 本文件已弃用，请使用 mentions.ts。
 * 统一的 mentions 模块同时支持 skill 与 source。
 *
 * 从聊天消息中解析 @skill mention 的工具函数（旧版 API，保留作向后兼容）。
 */

/**
 * 从消息文本中提取有效的 @skill mention。
 *
 * @param text - 要解析的消息文本
 * @param availableSlugs - 有效 skill slug 列表，用于过滤
 * @returns 文本中提到的唯一有效 skill slug 数组
 *
 * @example
 * parseSkillMentions('@bug-reporter help me fix this', ['bug-reporter', 'code-review'])
 * // 返回: ['bug-reporter']
 *
 * @example
 * parseSkillMentions('@foo @bar review this', ['bar'])
 * // 返回: ['bar']（foo 不是有效 slug）
 */
export function parseSkillMentions(text: string, availableSlugs: string[]): string[] {
  // 匹配 @word 模式（允许连字符与下划线）
  // 必须出现在字符串开头或空白符之后
  const mentionPattern = /(?:^|\s)@([\w-]+)/g
  const mentions = new Set<string>()

  let match
  while ((match = mentionPattern.exec(text)) !== null) {
    const slug = match[1]
    if (availableSlugs.includes(slug)) {
      mentions.add(slug)
    }
  }

  return Array.from(mentions)
}

/**
 * 从消息文本中移除 @mention。
 *
 * @param text - 带 mention 的消息文本
 * @returns 移除 @mention 后的文本，保留其他内容
 *
 * @example
 * stripSkillMentions('@bug-reporter help me fix this')
 * // 返回: 'help me fix this'
 */
export function stripSkillMentions(text: string): string {
  // 移除 @word 模式（必须位于开头或空白符后）
  return text
    .replace(/(?:^|\s)@[\w-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
