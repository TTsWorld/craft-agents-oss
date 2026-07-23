/**
 * 代码语法高亮的语言工具。
 * 将文件扩展名映射到语言标识符。
 */

/**
 * 文件扩展名到语言 ID 的映射表,用于语法高亮。
 */
export const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
  graphql: 'graphql',
  dockerfile: 'dockerfile',
  toml: 'toml',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
}

/**
 * 根据文件路径获取语言 ID。
 * @param filePath - 用于检测语言的文件路径
 * @param explicit - 可选的显式语言覆盖
 * @returns 语言 ID(默认为 'text')
 */
export function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase()
  return LANGUAGE_MAP[ext || ''] || 'text'
}

/**
 * 格式化文件路径用于展示,将 home 目录替换为 ~。
 * @param filePath - 待格式化的文件路径
 * @returns 格式化后的路径(如 /Users/john/code/file.ts → ~/code/file.ts)
 */
export function formatFilePath(filePath: string): string {
  const homeMatch = filePath.match(/^\/Users\/[^/]+\/(.+)$/)
  if (homeMatch) {
    return `~/${homeMatch[1]}`
  }
  return filePath
}

/**
 * 截断文件路径用于展示,保持文件名可见。
 * 截断优先级:中间 > 开头 > 结尾
 *
 * @param filePath - 待截断的文件路径
 * @param maxLength - 最大字符长度(默认:60)
 * @returns 截断后的路径,必要时在中间插入省略号
 *
 * 示例:
 * - ~/very/long/path/to/some/file.ts → ~/very/…/some/file.ts
 * - /extremely/long/path/file.ts → …/long/path/file.ts
 */
export function truncateFilePath(filePath: string, maxLength = 60): string {
  // 先格式化路径(把 home 目录替换为 ~)
  const formatted = formatFilePath(filePath)

  if (formatted.length <= maxLength) {
    return formatted
  }

  const parts = formatted.split('/')
  const filename = parts.pop() || ''

  // 如果文件名本身就过长,则从末尾截断
  if (filename.length >= maxLength - 3) {
    return filename.slice(0, maxLength - 3) + '…'
  }

  // 为文件名 + 省略号 + 分隔符预留空间
  const availableForPath = maxLength - filename.length - 4 // "…/" + 文件名前的 "/"

  if (availableForPath <= 0) {
    return '…/' + filename
  }

  // 尽量保留首尾的目录部分
  const dirPath = parts.join('/')

  if (dirPath.length <= availableForPath) {
    return formatted // 按理不会走到,但作为保护性检查
  }

  // 中间截断:保留目录路径的开头和结尾
  const halfAvailable = Math.floor(availableForPath / 2)
  const startPart = dirPath.slice(0, halfAvailable)
  const endPart = dirPath.slice(-(availableForPath - halfAvailable))

  // 清理截断点上的不完整目录名
  const cleanStart = startPart.includes('/') ? startPart.slice(0, startPart.lastIndexOf('/')) : startPart
  const cleanEnd = endPart.includes('/') ? endPart.slice(endPart.indexOf('/')) : '/' + endPart

  return cleanStart + '/…' + cleanEnd + '/' + filename
}
