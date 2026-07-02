/**
 * 自动标签规则校验
 *
 * 在保存配置时校验自动标签规则，提前发现非法正则语法
 * 和可能导致灾难性回溯的模式。
 *
 * 在 labels/config.json 写入时由标签配置校验器（validators.ts）调用。
 */

/**
 * 单条自动标签规则的校验结果。
 * valid 为 true 表示没有错误；errors/warnings 分别存放错误和警告信息。
 */
export interface AutoLabelValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * 已知的灾难性回溯模式（嵌套量词）。
 * 这些模式会让正则引擎在处理不匹配输入时耗时指数级增长，造成 ReDoS（正则拒绝服务）。
 *
 * 例如：(a+)+、(a*)+、(\w+)*、([a-z]+)+
 */
const CATASTROPHIC_BACKTRACKING_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/, // (x+)+、(x*)+、(x+)* 等
  /\([^)]*[+*][^)]*\)\{/,   // 带内部量词的量化组，如 (x+){n}
]

/**
 * 校验单条自动标签规则。
 * 检查正则语法、flags 和已知危险模式。
 *
 * @param pattern - 正则模式字符串
 * @param flags - 可选 flags（默认 'gi'）
 * @returns 包含 errors/warnings 的校验结果
 */
export function validateAutoLabelRule(pattern: string, flags?: string): AutoLabelValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. 检查正则能否正常编译
  try {
    const effectiveFlags = flags
      ? (flags.includes('g') ? flags : flags + 'g')
      : 'gi'
    new RegExp(pattern, effectiveFlags)
  } catch (e) {
    errors.push(`Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`)
    return { valid: false, errors, warnings }
  }

  // 2. 检查灾难性回溯模式（嵌套量词）
  for (const badPattern of CATASTROPHIC_BACKTRACKING_PATTERNS) {
    if (badPattern.test(pattern)) {
      errors.push(
        `Pattern contains nested quantifiers which can cause catastrophic backtracking (ReDoS). ` +
        `Simplify the pattern to avoid nested repetition like (a+)+.`
      )
      break
    }
  }

  // 3. 如果没有捕获组，警告：没有 valueTemplate 可用 $1
  if (!pattern.includes('(') || pattern.replace(/\(\?[:<!=]/g, '').indexOf('(') === -1) {
    warnings.push(
      'Pattern has no capture groups. The entire match will be used as the label value. ' +
      'Add capture groups (parentheses) to extract specific parts.'
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
