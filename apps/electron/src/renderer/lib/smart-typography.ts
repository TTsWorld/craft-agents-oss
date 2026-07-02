/**
 * 智能排版：输入时自动把常见字符组合替换为排版符号。
 *
 * 触发时机：用户在某个模式后输入空格时执行替换。
 * 这样可以避免处理复杂的部分匹配，体验也更自然。
 *
 * 支持的替换：
 * - -> → →（右箭头）
 * - <- → ←（左箭头）
 * - <-> → ↔（左右箭头）
 * - => → ⇒（双右箭头）
 * - <=> → ⇔（双向双箭头）
 * - -- → –（en-dash）
 * - ... → …（省略号）
 * - != → ≠（不等于）
 */

interface Replacement {
  /** 要匹配的模式（后面需跟一个空格才会触发） */
  pattern: string
  /** 替换后的字符/字符串 */
  replacement: string
}

/**
 * 按顺序排列的替换规则——长模式放前面，避免部分匹配。
 */
const REPLACEMENTS: Replacement[] = [
  // 长模式优先
  { pattern: '<=>', replacement: '⇔' },
  { pattern: '<->', replacement: '↔' },
  { pattern: '...', replacement: '…' },
  // 短模式
  { pattern: '->', replacement: '→' },
  { pattern: '<-', replacement: '←' },
  { pattern: '=>', replacement: '⇒' },
  { pattern: '--', replacement: '–' },
  { pattern: '!=', replacement: '≠' },
]

interface SmartTypographyResult {
  /** 替换后的文本 */
  text: string
  /** 调整后的光标位置 */
  cursor: number
  /** 是否发生了替换 */
  replaced: boolean
}

/**
 * 检查光标是否在代码块（反引号）内。
 * 简单启发式：光标前反引号数量为奇数时认为在代码内。
 */
function isInsideCode(text: string, cursor: number): boolean {
  const textBeforeCursor = text.slice(0, cursor)

  // 检查三重反引号（代码块）
  const tripleBackticks = (textBeforeCursor.match(/```/g) || []).length
  if (tripleBackticks % 2 === 1) return true

  // 检查单重反引号（行内代码）——先去掉三重反引号再计数
  const withoutTriple = textBeforeCursor.replace(/```/g, '')
  const singleBackticks = (withoutTriple.match(/`/g) || []).length
  return singleBackticks % 2 === 1
}

/**
 * 对文本应用智能排版替换。
 *
 * 当用户在某个模式后输入空格时触发替换。
 * 例如 "hello -> " 会变成 "hello → "。
 *
 * @param text - 当前输入文本
 * @param cursor - 当前光标位置
 * @returns 包含替换后文本、调整后光标位置、是否发生替换的对象
 */
export function applySmartTypography(
  text: string,
  cursor: number
): SmartTypographyResult {
  // 只在用户刚输入空格时做替换
  if (cursor === 0 || text[cursor - 1] !== ' ') {
    return { text, cursor, replaced: false }
  }

  // 光标在代码块内时不替换
  if (isInsideCode(text, cursor)) {
    return { text, cursor, replaced: false }
  }

  // 取空格之前的文本，检查是否以某个模式结尾
  const textBeforeSpace = text.slice(0, cursor - 1)

  // 按优先级尝试每个替换规则（长模式优先）
  for (const { pattern, replacement } of REPLACEMENTS) {
    if (textBeforeSpace.endsWith(pattern)) {
      // 命中：替换模式，保留空格
      const patternStart = cursor - 1 - pattern.length
      const newText =
        text.slice(0, patternStart) + replacement + ' ' + text.slice(cursor)

      // 调整光标：模式被更短的替换字符取代，空格保留
      const cursorAdjustment = pattern.length - replacement.length
      const newCursor = cursor - cursorAdjustment

      return { text: newText, cursor: newCursor, replaced: true }
    }
  }

  // 没有匹配到任何规则
  return { text, cursor, replaced: false }
}
