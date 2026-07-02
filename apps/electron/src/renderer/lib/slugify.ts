/**
 * 工作区名称的 slugify 工具。
 *
 * 把人类可读的名称转换成文件系统安全的 slug。
 * 例如："My Project" → "my-project"
 */

/**
 * 把字符串转换为 URL/文件系统安全的 slug：
 * - 转小写
 * - 把空格与下划线替换为连字符
 * - 移除非字母数字字符（连字符除外）
 * - 折叠多个连字符
 * - 去掉首尾连字符
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    // 空格与下划线转连字符
    .replace(/[\s_]+/g, '-')
    // 移除非字母数字字符（连字符保留）
    .replace(/[^a-z0-9-]/g, '')
    // 多个连字符折叠成一个
    .replace(/-+/g, '-')
    // 去掉首尾连字符
    .replace(/^-|-$/g, '')
}

/**
 * 检查字符串是否已是合法 slug（符合 slugify 输出格式）。
 */
export function isValidSlug(str: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(str)
}
