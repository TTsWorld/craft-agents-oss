/**
 * markdown 渲染的共享 remark-math 配置。
 *
 * 我们有意禁用单美元行内数学公式，使货币字符串
 *（如 $100, $2M–$4M）保持纯文本。
 */
export const MARKDOWN_MATH_OPTIONS = {
  singleDollarTextMath: false,
} as const
