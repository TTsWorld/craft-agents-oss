import LinkifyIt from 'linkify-it'
import { FILE_EXTENSIONS_PATTERN } from '../../lib/file-classification'

/**
 * Linkify - 用于 markdown 预处理的 URL 和文件路径检测
 *
 * 使用 linkify-it（每周 1200 万下载量）进行久经考验的 URL 检测，
 * 并辅以自定义正则来检测本地文件路径。
 */

// 以默认设置初始化 linkify-it（模糊 URL、邮箱检测开启）
const linkify = new LinkifyIt()

// 文件路径正则 - 检测绝对路径/家目录/显式相对路径/裸相对路径，需带常见扩展名
// 示例：/Users/foo.ts, ~/src/app.tsx, ./README.md, ../guide.md, apps/electron/src/main.ts
// 扩展名来源于 file-classification.ts，以与预览支持保持同步
const FILE_PATH_REGEX_SOURCE = `(?:^|[\\s([\\{<])((?:/|~/|\\./|\\.\\./|[A-Za-z0-9_][\\w\\-./@]*)[\\w\\-./@]*\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=[\\s)\\]}\\.,:;!?>]|$)`
const FILE_PATH_REGEX = new RegExp(FILE_PATH_REGEX_SOURCE, 'gi')
const FILE_PATH_PRETEST_REGEX = new RegExp(FILE_PATH_REGEX_SOURCE, 'i')

// 用于 markdown 锚点目标的文件路径正则（匹配整个 href/文本值）
// 由 Markdown.tsx 的点击处理器使用，将文件链接路由到 onFileClick。
const FILE_PATH_TARGET_REGEX = new RegExp(
  `^(?!https?://|mailto:|ftp://|data:)(?:/|~/|\./|\.\./|[A-Za-z0-9_][\\w\\-./@]*)[\\w\\-./@]*\\.(?:${FILE_EXTENSIONS_PATTERN})$`,
  'i'
)

interface DetectedLink {
  type: 'url' | 'email' | 'file'
  text: string
  url: string
  start: number
  end: number
}

interface CodeRange {
  start: number
  end: number
}

/**
 * 查找文本中所有代码块和行内代码区间
 * 这些区间应从链接检测中排除
 */
function findCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // 查找围栏代码块（```...```）
  const fencedRegex = /```[\s\S]*?```/g
  let match
  while ((match = fencedRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // 查找行内代码（`...`）
  // 但跳过转义反引号和围栏块内的代码
  const inlineRegex = /(?<!`)`(?!`)([^`\n]+)`(?!`)/g
  while ((match = inlineRegex.exec(text)) !== null) {
    const pos = match.index
    // 检查是否在围栏块内
    const insideFenced = ranges.some(r => pos >= r.start && pos < r.end)
    if (!insideFenced) {
      ranges.push({ start: pos, end: pos + match[0].length })
    }
  }

  return ranges
}

/**
 * 检查某位置是否落在任意代码区间内
 */
function isInsideCode(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * 查找文本中所有 markdown 链接区间：包括 [text](...) 和 [text][ref] 两种模式。
 * 返回覆盖整个链接语法的区间，使 preprocessLinks() 跳过这些区间内检测到的 URL，
 * 从而防止嵌套/损坏的链接。
 */
function findMarkdownLinkRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // 匹配 [text](url) — 行内链接
  const inlineLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\([^)]*\)/g
  let match
  while ((match = inlineLinkRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // 匹配 [text][ref] — 引用链接
  const refLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\[[^\]]*\]/g
  while ((match = refLinkRegex.exec(text)) !== null) {
    // 避免与已匹配的行内链接重复
    const r = { start: match.index, end: match.index + match[0].length }
    const alreadyCovered = ranges.some(existing => rangesOverlap(existing, r))
    if (!alreadyCovered) {
      ranges.push(r)
    }
  }

  return ranges
}

/**
 * 检查某位置是否落在任意 markdown 链接区间内
 */
function isInsideMarkdownLink(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * 检查两个区间是否重叠
 */
function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * 检测文本中所有链接（URL、邮箱、文件路径）
 */
export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = []

  // 1. 用 linkify-it 检测 URL 和邮箱
  const urlMatches = linkify.match(text) || []
  // linkify-it 不会去除粗体/斜体 markdown 的尾部星号，
  // 这会导致 URL 被 **url** 或 *url* 包裹时出现损坏的链接
  // 注意：_ 和 ~ 是合法 URL 字符，因此只去除 *
  const trailingMarkdownRe = /\*+$/
  for (const match of urlMatches) {
    let matchText = match.text
    let matchUrl = match.url
    let matchEnd = match.lastIndex

    const stripped = matchText.replace(trailingMarkdownRe, '')
    if (stripped !== matchText) {
      const diff = matchText.length - stripped.length
      matchText = stripped
      matchUrl = matchUrl.replace(trailingMarkdownRe, '')
      matchEnd -= diff
    }

    links.push({
      type: match.schema === 'mailto:' ? 'email' : 'url',
      text: matchText,
      url: matchUrl,
      start: match.index,
      end: matchEnd
    })
  }

  // 2. 用自定义正则检测文件路径
  // 重置正则状态
  FILE_PATH_REGEX.lastIndex = 0
  let fileMatch
  while ((fileMatch = FILE_PATH_REGEX.exec(text)) !== null) {
    const path = fileMatch[1]
    if (!path) continue // 无捕获组则跳过

    // 计算实际起始位置（跳过前导空白/标点）
    const fullMatch = fileMatch[0]
    const pathOffset = fullMatch.indexOf(path)
    const start = fileMatch.index + pathOffset

    // 检查与 URL 匹配的重叠（URL 优先）
    const pathRange = { start, end: start + path.length }
    const overlapsUrl = links.some(link => rangesOverlap(pathRange, link))
    if (overlapsUrl) continue

    links.push({
      type: 'file',
      text: path,
      url: path, // 文件路径原样传递给 onFileClick 处理器
      start,
      end: start + path.length
    })
  }

  // 按位置排序
  return links.sort((a, b) => a.start - b.start)
}

/**
 * 检测 AI 在不知道真实 URL 时生成的占位/伪造 URL。
 * 例如 `https://github.com/...` 或 `https://example.com/...` 这类 URL，
 * 应被还原为行内代码而非渲染为链接。
 */
const PLACEHOLDER_URL_PATTERN = /\/\.\.\.(?:[)/\s#?]|$)/

/**
 * 检查 URL 是否为占位/伪造 URL。
 * 当 URL 包含 `/...` 这类路径段时返回 true
 */
export function isPlaceholderUrl(url: string): boolean {
  return PLACEHOLDER_URL_PATTERN.test(url)
}

/**
 * 将带占位 URL 的 markdown 链接还原为纯文本。
 * 将 `[text](https://github.com/...)` → `text`
 * 遵守代码块——围栏或行内代码内的链接不会被处理。
 */
function stripPlaceholderLinks(text: string): string {
  const codeRanges = findCodeRanges(text)
  // 匹配 url 中包含占位模式的 markdown 链接 [text](url)
  return text.replace(
    /\[([^\[\]]*)\]\(([^)]*)\)/g,
    (fullMatch, linkText: string, url: string, offset: number) => {
      // 不处理代码块内的链接
      if (isInsideCode(offset, codeRanges)) return fullMatch

      if (isPlaceholderUrl(url)) {
        // 去除链接，仅保留显示文本作为纯文本
        if (!linkText.trim()) return fullMatch
        return linkText
      }
      return fullMatch
    }
  )
}

/**
 * 预处理文本，将原始 URL 和文件路径转换为 markdown 链接
 * 跳过代码块和已链接的内容
 */
export function preprocessLinks(text: string): string {
  // 第一遍：去除带占位/伪造 URL 的 markdown 链接
  //（例如 AI 生成的 `[commit](https://github.com/...)` → `\`commit\``）
  text = stripPlaceholderLinks(text)

  // 快速检查 - 若无潜在链接则提前返回
  if (!linkify.pretest(text) && !FILE_PATH_PRETEST_REGEX.test(text)) {
    return text
  }

  const codeRanges = findCodeRanges(text)
  const markdownLinkRanges = findMarkdownLinkRanges(text)
  const links = detectLinks(text)

  if (links.length === 0) return text

  // 构建结果，将原始链接转换为 markdown 链接
  let result = ''
  let lastIndex = 0

  for (const link of links) {
    // 跳过代码块内的链接
    if (isInsideCode(link.start, codeRanges)) continue

    // 跳过已存在的 markdown 链接内的链接（文本或 href 部分）
    if (isInsideMarkdownLink(link.start, markdownLinkRanges)) continue

    // 添加此链接之前的文本
    result += text.slice(lastIndex, link.start)

    // 转换为 markdown 链接
    result += `[${link.text}](${link.url})`

    lastIndex = link.end
  }

  // 添加剩余文本
  result += text.slice(lastIndex)

  return result
}

/**
 * 测试文本是否包含任何可检测的链接
 * 用于优化 - 无链接时跳过预处理
 */
export function hasLinks(text: string): boolean {
  return linkify.pretest(text) || FILE_PATH_PRETEST_REGEX.test(text)
}

/**
 * 检查 markdown 锚点目标是否应被视为本地文件路径。
 * 供点击处理器使用，将本地路径路由到 onFileClick 而非 onUrlClick。
 */
export function isFilePathTarget(target: string): boolean {
  return FILE_PATH_TARGET_REGEX.test(target.trim())
}
