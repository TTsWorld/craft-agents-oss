const MERMAID_DIAGRAM_PREFIXES = [
  'graph ',
  'flowchart ',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'xychart',
  'xychart-beta',
]

/** 从图示开头移除 Mermaid YAML frontmatter（`--- ... ---`）。 */
export function stripMermaidFrontmatter(code: string): string {
  const withoutBom = code.replace(/^\uFEFF/, '')
  const leadingWhitespace = withoutBom.match(/^\s*/)?.[0] ?? ''
  const candidate = withoutBom.slice(leadingWhitespace.length)
  const lines = candidate.split(/\r?\n/)

  if (lines[0]?.trim() !== '---') return code

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (endIndex === -1) return code

  return lines.slice(endIndex + 1).join('\n').trimStart()
}

/**
 * 在交给原生渲染器之前对 Mermaid 进行归一化。
 * Frontmatter 是元数据，前导注释/指令不应控制按第一个有效行路由的
 * 渲染器的图示类型检测。
 */
export function normalizeMermaidSource(code: string): string {
  const lines = stripMermaidFrontmatter(code).split(/\r?\n/)
  while (lines.length > 0) {
    const first = lines[0]?.trim() ?? ''
    if (first.length === 0 || first.startsWith('%%')) {
      lines.shift()
      continue
    }
    break
  }
  return lines.join('\n').trimStart()
}

export function getFirstMermaidDiagramLine(code: string): string | null {
  const first = normalizeMermaidSource(code).split(/\r?\n/)[0]?.trim()
  return first && first.length > 0 ? first : null
}

export function looksLikeMermaidSource(code: string): boolean {
  const firstMeaningful = getFirstMermaidDiagramLine(code)
  if (!firstMeaningful) return false
  return MERMAID_DIAGRAM_PREFIXES.some(prefix => firstMeaningful.startsWith(prefix))
}
