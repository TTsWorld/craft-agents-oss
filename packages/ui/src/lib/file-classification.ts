/**
 * 链接拦截器使用的文件类型分类。
 *
 * 通过扩展名对文件路径进行分类，以判断应用能否展示
 * 应用内预览浮层，以及应使用哪种预览类型。
 * 供 useLinkInterceptor 用于决定应用内预览还是外部打开。
 */

/** 映射到特定浮层组件的预览类型 */
export type FilePreviewType = 'image' | 'code' | 'markdown' | 'json' | 'text' | 'pdf'

export interface FileClassification {
  /** 预览类型，若无应用内预览则为 null */
  type: FilePreviewType | null
  /** 该文件是否可在应用内预览 */
  canPreview: boolean
}

/**
 * 图片格式 —— 通过 data URL 在 ImagePreviewOverlay 中渲染。
 * 仅包含 Chromium 可原生解码的格式。
 * 不含 HEIC/HEIF 和 TIFF —— Chromium 没有对应编解码器，
 * 因此它们会回落到系统打开（外部应用）。
 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
])

/**
 * 代码文件扩展名 —— 在 CodePreviewOverlay 中带语法高亮渲染。
 * 与 file-utils.ts 中的 LANGUAGE_MAP 对应，但此处仅作为扁平集合用于分类。
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less',
  'html', 'htm', 'xml', 'svg',  // SVG 也可作为代码查看，但图片优先级更高
  'yaml', 'yml', 'toml',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql',
  'dockerfile',
  'makefile',
  'r', 'lua', 'perl', 'php',
  'vue', 'svelte', 'astro', 'prisma',
])

/** Markdown 文件 —— 使用 Markdown 组件渲染 */
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx'])

/** JSON 文件 —— 在 JSONPreviewOverlay 或代码查看器中渲染 */
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])

/** 纯文本文件 —— 在代码查看器中以纯文本渲染 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'tsv',
  'cfg', 'ini', 'conf',
  'env', 'env.local', 'env.development', 'env.production',
  'gitignore', 'gitattributes', 'editorconfig',
  'npmrc', 'nvmrc',
  'rtf',
])

/** PDF 文件 —— 通过内嵌查看器在 PDFPreviewOverlay 中渲染 */
const PDF_EXTENSIONS = new Set(['pdf'])

/**
 * 仅外部打开的文件扩展名 —— 被识别为文件链接但通过外部方式打开。
 * 它们被包含在 FILE_EXTENSIONS_PATTERN 中以便 linkify.ts 将其检测为文件路径，
 * 但 classifyFile() 返回 canPreview: false，因此会路由到系统打开器。
 */
const EXTERNAL_EXTENSIONS = new Set([
  'xlsx', 'xls', 'xlsm',   // 电子表格
  'docx', 'doc',             // Word 文档
  'pptx', 'ppt',             // 演示文稿
  'zip', 'tar', 'gz', 'rar', '7z',  // 压缩包
  'dmg', 'pkg', 'exe', 'msi',       // 安装包
  'mp3', 'wav', 'flac', 'aac',      // 音频
  'mp4', 'mov', 'avi', 'mkv',       // 视频
  'heic', 'heif', 'tiff', 'tif',    // Chromium 无法解码的图片
])

/**
 * 从路径中提取文件扩展名（小写形式）。
 * 对于 .env.local 这类复合扩展名，返回最后一段。
 */
function getExtension(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === 0) return ''
  return basename.slice(dotIndex + 1).toLowerCase()
}

/**
 * 通过扩展名对文件路径进行分类以确定预览能力。
 *
 * 当扩展名匹配多个集合时（如 svg）的优先级顺序：
 * image > code > markdown > json > text > pdf
 */
export function classifyFile(filePath: string): FileClassification {
  const ext = getExtension(filePath)
  if (!ext) return { type: null, canPreview: false }

  if (IMAGE_EXTENSIONS.has(ext))    return { type: 'image', canPreview: true }
  if (MARKDOWN_EXTENSIONS.has(ext)) return { type: 'markdown', canPreview: true }
  if (JSON_EXTENSIONS.has(ext))     return { type: 'json', canPreview: true }
  if (CODE_EXTENSIONS.has(ext))     return { type: 'code', canPreview: true }
  if (TEXT_EXTENSIONS.has(ext))     return { type: 'text', canPreview: true }
  if (PDF_EXTENSIONS.has(ext))      return { type: 'pdf', canPreview: true }

  return { type: null, canPreview: false }
}

/**
 * 所有可能的文件扩展名的正则或表达式（如 "ts|tsx|js|..."）。
 * 派生自上方的分类集合，使链接检测与预览支持自动保持同步。
 */
export const FILE_EXTENSIONS_PATTERN = [
  ...IMAGE_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...JSON_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...EXTERNAL_EXTENSIONS,
].join('|')
