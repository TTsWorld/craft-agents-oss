/**
 * 文件工具函数：语言检测与路径格式化。
 * 在代码预览、diff 预览、多文件 diff 等组件中复用。
 */

/**
 * 文件扩展名到 Monaco 编辑器语言 ID 的映射表。
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
 * 根据文件路径获取 Monaco 语言 ID。
 * @param filePath - 待检测的文件路径
 * @param explicit - 可选的显式语言覆盖
 * @returns Monaco 语言 ID（默认返回 'plaintext'）
 */
export function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit

  const ext = filePath.split('.').pop()?.toLowerCase()
  return LANGUAGE_MAP[ext || ''] || 'plaintext'
}

/**
 * 格式化文件路径用于展示，把 /Users/xxx 前缀替换为 ~。
 * @param filePath - 待格式化的文件路径
 * @returns 格式化后的路径，例如 /Users/john/code/file.ts → ~/code/file.ts
 */
export function formatFilePath(filePath: string): string {
  const homeMatch = filePath.match(/^\/Users\/[^/]+\/(.+)$/)
  if (homeMatch) {
    return `~/${homeMatch[1]}`
  }
  return filePath
}
