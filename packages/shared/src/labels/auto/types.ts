/**
 * 自动标签类型
 *
 * 自动标签求值管道的返回类型。
 * AutoLabelMatch 表示从用户消息中提取出的一个标签+值。
 */

/**
 * 自动标签求值得到的一次匹配。
 * 表示应当应用到 session 上的某个标签。
 */
export interface AutoLabelMatch {
  /** 要应用的标签 ID */
  labelId: string
  /** 已按 valueType 格式化、可直接存储的归一化值 */
  value: string
  /** 消息中触发本次匹配的原始文本 */
  matchedText: string
}
