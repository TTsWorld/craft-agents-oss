/**
 * 自动标签值归一化
 *
 * 根据标签的 valueType 对正则提取出的原始值做归一化。
 * 在 valueTemplate 替换完捕获组后调用。
 *
 * 归一化规则：
 * - string：原样返回
 * - number：去掉逗号，展开 k/K/M/B 后缀
 * - date：原样返回（正则捕获已产出 ISO 格式）
 * - link：去掉首尾空白（URL 原样存储）
 */

/**
 * 根据目标标签的 valueType 归一化原始提取值。
 * 返回可直接存入会话标签条目的字符串。
 *
 * @param raw - valueTemplate 替换后得到的原始值字符串
 * @param valueType - 标签声明的 valueType，决定归一化策略
 */
export function normalizeValue(raw: string, valueType?: 'string' | 'number' | 'date' | 'link'): string {
  switch (valueType) {
    case 'number':
      return normalizeNumber(raw)
    case 'date':
      // 来自正则捕获的日期值应当已经是 ISO 格式
      return raw
    case 'link':
      // URL 原样存储，仅去掉首尾空白
      return raw.trim()
    case 'string':
    default:
      return raw
  }
}

/**
 * 归一化数字字符串：
 * - 去掉千分位逗号："45,000" → "45000"
 * - 去掉前置货币符号："$45000" → "45000"
 * - 展开 k/K 后缀："45k" → "45000"
 * - 展开 M 后缀："1.5M" → "1500000"
 * - 展开 B 后缀："2B" → "2000000000"
 */
function normalizeNumber(raw: string): string {
  // 去掉前置货币符号
  let cleaned = raw.replace(/^[$€£¥]/, '')

  // 去掉逗号
  cleaned = cleaned.replace(/,/g, '')

  // 展开后缀（不区分大小写）
  const suffixMatch = cleaned.match(/^(-?\d+\.?\d*)\s*([kKmMbB])$/)
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1]!)
    const suffix = suffixMatch[2]!.toLowerCase()
    const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1_000_000_000
    const result = num * multiplier
    // 避免浮点误差：如果是整数就返回整数形式
    return Number.isInteger(result) ? result.toString() : result.toFixed(2)
  }

  // 尝试按普通数字解析（验证它确实是数字）
  const parsed = parseFloat(cleaned)
  if (!isNaN(parsed) && isFinite(parsed)) {
    return Number.isInteger(parsed) ? parsed.toString() : parsed.toString()
  }

  // 回退：若解析不出数字，返回清理后的字符串
  return cleaned
}
