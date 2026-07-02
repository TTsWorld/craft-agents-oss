/**
 * 自动化相关的安全工具
 *
 * 提供 shell 环境变量注入的防御性转义，防止通过环境变量进行命令注入攻击。
 */

/**
 * 对字符串进行 shell 安全转义，避免命令注入。
 *
 * @param value - 需要转义的字符串
 * @returns 转义后可用于 shell 环境变量的字符串
 *
 * @example
 * sanitizeForShell('$(rm -rf /)') // 返回 '\\$(rm -rf /)'
 * sanitizeForShell('`whoami`')    // 返回 '\\`whoami\\`'
 */
export function sanitizeForShell(value: string): string {
  // 先转义反斜杠，再转义其他可能被用于命令注入的元字符：
  // 反引号、$、双引号、单引号、换行符、回车符
  return value
    .replace(/\\/g, '\\\\')     // 反斜杠
    .replace(/`/g, '\\`')       // 反引号（命令替换）
    .replace(/\$/g, '\\$')      // $（变量展开）
    .replace(/"/g, '\\"')       // 双引号
    .replace(/'/g, "\\'")       // 单引号
    .replace(/\n/g, '\\n')      // 换行
    .replace(/\r/g, '\\r');     // 回车
}
