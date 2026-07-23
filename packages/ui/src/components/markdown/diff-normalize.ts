const FILE_HEADER_OLD = /^---[ \t]+\S/
const FILE_HEADER_NEW = /^\+\+\+[ \t]+\S/
const GIT_DIFF_HEADER = /^diff --git[ \t]/
const FILE_HEADER_CAPTURE = /^(---|\+\+\+)[ \t]+([^\t\r\n]+)/
const VALID_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/
const HUNK_LIKE = /^@@(?:[ \t]|$)/

function isFileHeaderPair(lines: string[], index: number): boolean {
  return FILE_HEADER_OLD.test(lines[index] ?? '') && FILE_HEADER_NEW.test(lines[index + 1] ?? '')
}

function findFirstHunkIndex(lines: string[]): number {
  return lines.findIndex(line => HUNK_LIKE.test(line))
}

function findFileHeaderPairBefore(lines: string[], endIndex: number): number {
  for (let i = 0; i < endIndex - 1; i++) {
    if (isFileHeaderPair(lines, i)) return i
  }
  return -1
}

function hasGitHeaderBefore(lines: string[], endIndex: number): boolean {
  return lines.slice(0, endIndex).some(line => GIT_DIFF_HEADER.test(line))
}

function countGitHeaders(lines: string[]): number {
  return lines.filter(line => GIT_DIFF_HEADER.test(line)).length
}

function getHeaderPath(lines: string[], marker: '---' | '+++'): string | undefined {
  const headerLine = lines.find(line => line.startsWith(marker))
  return headerLine?.match(FILE_HEADER_CAPTURE)?.[2]
}

function toGitPath(path: string | undefined, side: 'a' | 'b'): string {
  if (path == null || path === '/dev/null') return `${side}/file`

  const normalized = path.replace(/^[ab]\//, '')
  return `${side}/${normalized}`
}

function withSyntheticGitHeader(prefixLines: string[]): string[] {
  if (prefixLines.some(line => GIT_DIFF_HEADER.test(line))) return prefixLines

  const oldPath = toGitPath(getHeaderPath(prefixLines, '---'), 'a')
  const newPath = toGitPath(getHeaderPath(prefixLines, '+++'), 'b')
  return [`diff --git ${oldPath} ${newPath}`, ...prefixLines]
}

function containsUnifiedFileBreakCandidate(lines: string[]): boolean {
  return lines.some(line => FILE_HEADER_OLD.test(line))
}

/**
 * 将原始 diff 正文(即 ```diff markdown 代码块中的内容)规范化为
 * @pierre/diffs 的 PatchDiff 可解析的 unified diff 形态。
 *
 * - 已合法的单文件 unified/git diff 原样逐字节返回。
 * - 合法的带行号 hunk 但无文件头时,前补占位文件头。
 * - 裸的或格式错误的 @@ 标记行会被折叠为单个合成的 hunk。
 */
export function ensureUnifiedDiffFormat(raw: string): string {
  const lines = raw.split('\n')
  const hunkLines = lines.filter(line => HUNK_LIKE.test(line))
  const firstHunkIndex = findFirstHunkIndex(lines)
  const hunkSearchEnd = firstHunkIndex === -1 ? lines.length : firstHunkIndex

  const allHunksValid = hunkLines.length > 0 && hunkLines.every(line => VALID_HUNK.test(line))
  const hasGitHeader = hasGitHeaderBefore(lines, hunkSearchEnd)
  const fileHeaderPairIndex = findFileHeaderPairBefore(lines, hunkSearchEnd)
  const hasFileIdentity = hasGitHeader || fileHeaderPairIndex !== -1

  // PatchDiff 只接受单个文件。多文件 patch 原样保留,
  // 以便已有的错误边界能回退到 CodeBlock,而不是把多个文件伪装成一个合成文件。
  const isMultiFile = countGitHeaders(lines) > 1
  if (isMultiFile) return raw

  // 可直接解析的 diff 走快速路径:合法 hunk 加文件身份,已是 @pierre/diffs 期望的形态。
  if (allHunksValid && hasFileIdentity) return raw

  // 仅含合法 hunk 的 diff 只需补占位文件头。保留原始 hunk 行元数据和多 hunk 结构。
  // 若正文中包含形似 unified 文件头的删除行(`--- ...`),则补一个合成 git 头,
  // 以免 @pierre/diffs 把它当作第二个文件切分。
  if (allHunksValid) {
    const prefixLines = ['--- a/file', '+++ b/file']
    const outputPrefixLines = containsUnifiedFileBreakCandidate(lines)
      ? withSyntheticGitHeader(prefixLines)
      : prefixLines
    return [...outputPrefixLines, raw].join('\n')
  }

  // 针对格式错误/裸标记的情况:若存在前导文件元数据/头前缀,则保留。
  // 有 hunk 时,第一个 hunk 之前的所有内容都算前缀。
  // 无 hunk 时,若存在前导 unified 头对则保留。
  let prefixEnd = 0
  if (hasFileIdentity && firstHunkIndex !== -1) {
    prefixEnd = firstHunkIndex
  } else if (fileHeaderPairIndex !== -1) {
    prefixEnd = fileHeaderPairIndex + 2
  }

  const prefixLines = prefixEnd > 0 ? lines.slice(0, prefixEnd) : ['--- a/file', '+++ b/file']
  const bodyLines = lines.slice(prefixEnd).filter(line => !HUNK_LIKE.test(line))
  const outputPrefixLines = containsUnifiedFileBreakCandidate(bodyLines)
    ? withSyntheticGitHeader(prefixLines)
    : prefixLines

  let origCount = 0
  let modCount = 0
  for (const line of bodyLines) {
    if (line.startsWith('-')) origCount++
    else if (line.startsWith('+')) modCount++
    else {
      origCount++
      modCount++
    }
  }

  return [
    ...outputPrefixLines,
    `@@ -1,${origCount} +1,${modCount} @@`,
    ...bodyLines,
  ].join('\n')
}
