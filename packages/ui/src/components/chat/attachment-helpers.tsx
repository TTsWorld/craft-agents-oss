/**
 * 用于展示文件类型图标和标签的附件辅助工具
 *
 * 在用户消息中渲染文件附件的共享工具。
 * Electron 应用和 web viewer 共同使用。
 */

import { File, Image as ImageIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AttachmentType } from '@craft-agent/core'

// MIME 类型到人类友好标签的完整映射
const MIME_TYPE_LABELS: Record<string, string> = {
  // 文档
  'application/pdf': 'PDF',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/rtf': 'RTF',

  // 文本与标记语言
  'text/plain': 'Text',
  'text/markdown': 'Markdown',
  'text/html': 'HTML',
  'text/css': 'CSS',
  'text/csv': 'CSV',
  'text/xml': 'XML',
  'application/xml': 'XML',
  'application/json': 'JSON',
  'application/x-yaml': 'YAML',
  'text/yaml': 'YAML',

  // 代码
  'text/javascript': 'JavaScript',
  'application/javascript': 'JavaScript',
  'text/typescript': 'TypeScript',
  'application/typescript': 'TypeScript',
  'text/x-python': 'Python',
  'text/x-java': 'Java',
  'text/x-c': 'C',
  'text/x-c++': 'C++',
  'text/x-csharp': 'C#',
  'text/x-go': 'Go',
  'text/x-rust': 'Rust',
  'text/x-swift': 'Swift',
  'text/x-kotlin': 'Kotlin',
  'text/x-ruby': 'Ruby',
  'text/x-php': 'PHP',
  'application/x-sh': 'Shell',
  'text/x-shellscript': 'Shell',

  // 图片
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',

  // 归档
  'application/zip': 'ZIP',
  'application/x-rar-compressed': 'RAR',
  'application/x-7z-compressed': '7-Zip',
  'application/gzip': 'GZIP',
  'application/x-tar': 'TAR',

  // 媒体
  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
}

// MIME 类型为通用类型（例如 application/octet-stream）时的扩展名兜底
const EXTENSION_LABELS: Record<string, string> = {
  // 代码
  'js': 'JavaScript',
  'ts': 'TypeScript',
  'tsx': 'React TSX',
  'jsx': 'React JSX',
  'py': 'Python',
  'rb': 'Ruby',
  'go': 'Go',
  'rs': 'Rust',
  'swift': 'Swift',
  'kt': 'Kotlin',
  'java': 'Java',
  'c': 'C',
  'cpp': 'C++',
  'h': 'Header',
  'cs': 'C#',
  'php': 'PHP',
  'sh': 'Shell',
  'bash': 'Bash',
  'zsh': 'Zsh',

  // 配置
  'json': 'JSON',
  'yaml': 'YAML',
  'yml': 'YAML',
  'toml': 'TOML',
  'xml': 'XML',
  'ini': 'Config',
  'env': 'Env',

  // 文档
  'md': 'Markdown',
  'txt': 'Text',
  'rtf': 'RTF',
  'pdf': 'PDF',
  'doc': 'Word',
  'docx': 'Word',
  'xls': 'Excel',
  'xlsx': 'Excel',
  'ppt': 'PowerPoint',
  'pptx': 'PowerPoint',
  'csv': 'CSV',
}

/**
 * 获取文件类型的人类友好标签
 */
export function getFileTypeLabel(type: AttachmentType, mimeType: string, fileName?: string): string {
  // 1. 检查精确的 MIME 类型匹配
  if (MIME_TYPE_LABELS[mimeType]) {
    return MIME_TYPE_LABELS[mimeType]
  }

  // 2. 尝试从文件名扩展名提取
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase()
    if (ext && EXTENSION_LABELS[ext]) {
      return EXTENSION_LABELS[ext]
    }
  }

  // 3. 按类型分类兜底
  switch (type) {
    case 'pdf': return 'PDF'
    case 'office': return 'Document'
    case 'text': return 'Text'
    case 'image': return 'Image'
    default: return 'File'
  }
}

export interface FileTypeIconProps {
  type: AttachmentType
  mimeType: string
  className?: string
}

/**
 * 文件图标——图片用 ImageIcon，其余用带色彩倾向的通用 File 图标
 */
export function FileTypeIcon({ type, mimeType, className }: FileTypeIconProps) {
  const baseClass = cn("h-4 w-4", className)

  // 图片使用专属图标
  if (type === 'image') {
    return <ImageIcon className={cn(baseClass, "text-accent")} />
  }

  // 其余使用带色彩倾向的通用文件图标
  const colorClass = getFileColor(type, mimeType)
  return <File className={cn(baseClass, colorClass)} />
}

function getFileColor(type: AttachmentType, mimeType: string): string {
  // 代码文件使用 success 色
  if (isCodeFile(mimeType)) {
    return "text-success"
  }

  switch (type) {
    case 'pdf':
      return "text-destructive"
    case 'office':
      return "text-accent"
    case 'text':
      return "text-muted-foreground"
    default:
      return "text-muted-foreground"
  }
}

function isCodeFile(mimeType: string): boolean {
  const codeTypes = [
    'application/javascript',
    'application/typescript',
    'application/json',
    'text/javascript',
    'text/typescript',
    'text/x-python',
    'text/x-java',
    'text/css',
    'text/html',
    'text/xml',
    'application/xml',
    'text/yaml',
  ]
  return codeTypes.includes(mimeType) || mimeType.startsWith('text/x-')
}
