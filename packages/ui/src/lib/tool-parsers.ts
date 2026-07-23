/**
 * 工具结果解析器
 *
 * 用于解析 Claude Code SDK 工具结果的共享工具集。
 * 供 Electron 和查看器应用共同使用，以保证浮层展示的一致性。
 */

import type { ActivityItem } from '../components/chat/TurnCard'
import type { ToolType } from '../components/terminal/TerminalOutput'

// ============================================================================
// 各工具解析器
// ============================================================================

export interface ReadResult {
  content: string
  numLines?: number
  startLine?: number
  totalLines?: number
}

/**
 * 解析 Read 工具的 JSON 结果，提取文件内容与元数据。
 */
export function parseReadResult(rawContent: string): ReadResult {
  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.file) {
      return {
        content: parsed.file.content || '',
        numLines: parsed.file.numLines,
        startLine: parsed.file.startLine,
        totalLines: parsed.file.totalLines,
      }
    }
  } catch {
    // 非 JSON，按纯文本处理
  }
  return { content: rawContent }
}

export interface BashResult {
  output: string
  exitCode?: number
}

/**
 * 解析 Bash 工具的 JSON 结果，提取输出与退出码。
 */
export function parseBashResult(rawContent: string): BashResult {
  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.stdout !== undefined || parsed.stderr !== undefined) {
      const stdout = parsed.stdout || ''
      const stderr = parsed.stderr || ''
      return {
        output: stdout + (stderr ? `\n${stderr}` : ''),
        exitCode: parsed.interrupted ? 130 : parsed.exitCode,
      }
    }
  } catch {
    // 非 JSON，尝试从文本中提取退出码
    const exitMatch = rawContent.match(/Exit code: (\d+)/)
    if (exitMatch && exitMatch[1]) {
      return { output: rawContent, exitCode: parseInt(exitMatch[1], 10) }
    }
  }
  return { output: rawContent }
}

export interface GrepResult {
  output: string
  description: string
  command: string
}

/**
 * 解析 Grep 工具的 JSON 结果，提取搜索结果。
 */
export function parseGrepResult(
  rawContent: string,
  pattern: string,
  searchPath: string,
  outputMode: string
): GrepResult {
  let output = rawContent
  let description = `Search for "${pattern}"`

  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.content !== undefined) {
      output = parsed.content || ''
      if (parsed.numFiles !== undefined) {
        description = `Search for "${pattern}" (${parsed.numFiles} files, ${parsed.numLines || 0} lines)`
      }
    } else if (parsed.filenames) {
      // files_with_matches 模式返回文件名数组
      output = parsed.filenames.join('\n')
      description = `Search for "${pattern}" (${parsed.filenames.length} files)`
    }
  } catch {
    // 非 JSON，按纯文本处理
  }

  const command = `grep "${pattern}" ${searchPath} --${outputMode}`
  return { output, description, command }
}

export interface GlobResult {
  output: string
  description: string
  command: string
}

/**
 * 解析 Glob 工具的 JSON 结果，提取文件列表。
 */
export function parseGlobResult(
  rawContent: string,
  pattern: string,
  searchPath: string
): GlobResult {
  let output = rawContent
  let description = `Find files matching "${pattern}"`

  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.filenames && Array.isArray(parsed.filenames)) {
      // 标准 Glob 结果格式：{ filenames: [...], numFiles, durationMs, truncated }
      output = parsed.filenames.join('\n')
      const truncated = parsed.truncated ? ' (truncated)' : ''
      description = `Find files matching "${pattern}" (${parsed.numFiles || parsed.filenames.length} files${truncated})`
    } else if (Array.isArray(parsed)) {
      // 简单数组格式
      output = parsed.join('\n')
      description = `Find files matching "${pattern}" (${parsed.length} matches)`
    }
  } catch {
    // 非 JSON，按纯文本处理
  }

  const command = `glob "${pattern}" in ${searchPath}`
  return { output, description, command }
}

/**
 * 解析 WebSearch 工具结果，将其中内嵌的 JSON 链接正确格式化。
 * 将 "Links: [...]" 中的原始 JSON 数组转换为格式化的 markdown 列表。
 * 处理单个结果中的多个 Links 段落。
 */
export function parseWebSearchResult(rawContent: string): string {
  // 查找所有 Links: [...] 模式（可能跨多行）
  // 使用函数替换器逐个处理每个匹配
  return rawContent.replace(/Links: (\[[\s\S]*?\])(?=\n|$)/g, (match, jsonArray) => {
    try {
      const links = JSON.parse(jsonArray) as Array<{ title: string; url: string }>

      // 格式化为带域名前缀的 markdown 列表
      const linksList = links.map(link => {
        const domain = new URL(link.url).hostname.replace(/^www\./, '')
        return `- [${domain} - ${link.title}](${link.url})`
      }).join('\n')

      return `**Links:**\n${linksList}`
    } catch {
      // JSON 解析失败时，改为包裹在代码块中
      return `Links:\n\`\`\`json\n${jsonArray}\n\`\`\``
    }
  })
}

// ============================================================================
// 浮层数据类型
// ============================================================================

export interface CodeOverlayData {
  type: 'code'
  filePath: string
  content: string
  mode: 'read' | 'write'
  startLine?: number
  totalLines?: number
  numLines?: number
  error?: string
  /** 原始 shell 命令（用于 Codex 读取）- 在浮层中展示 */
  command?: string
}

export interface TerminalOverlayData {
  type: 'terminal'
  command: string
  output: string
  exitCode?: number
  toolType: ToolType
  description: string
  error?: string
}

export interface GenericOverlayData {
  type: 'generic'
  content: string
  title: string
  error?: string
}

export interface JSONOverlayData {
  type: 'json'
  data: unknown
  rawContent: string
  title: string
  error?: string
}

/** 渲染后的 markdown 文档 —— 用于 .md/.txt 文件的 Write 工具结果 */
export interface DocumentOverlayData {
  type: 'document'
  content: string
  filePath: string
  /** 产生该内容的工具（如 "Write"）—— 用于头部类型徽章 */
  toolName: string
  error?: string
}

export type OverlayData = CodeOverlayData | TerminalOverlayData | GenericOverlayData | JSONOverlayData | DocumentOverlayData

/** 用于 activity 详情的通用浮层卡片模型（标签页项）。 */
export interface OverlayCard {
  /** 稳定的卡片标识（如 input、output、metadata） */
  id: string
  /** 在卡片导航器中展示的标签 */
  label: string
  /** 由浮层渲染的卡片数据 */
  data: OverlayData
  /** 可选的 CLI 风格命令预览（在 Input 卡片上展示） */
  commandPreview?: string
}

// ============================================================================
// 主提取函数
// ============================================================================

/**
 * 从 activity 项中提取浮层数据。
 * 返回类型化数据以渲染对应的浮层组件。
 */
export function extractOverlayData(activity: ActivityItem): OverlayData | null {
  if (!activity) return null

  const input = activity.toolInput as Record<string, unknown> | undefined
  const rawContent = activity.content || ''
  const toolName = activity.toolName?.toLowerCase() || ''

  // 从各种输入格式中获取文件路径
  const filePath = (input?.file_path as string) || (input?.path as string) || 'file'

  // Read 工具 → Code 浮层（读取模式）
  if (toolName === 'read') {
    const parsed = parseReadResult(rawContent)
    return {
      type: 'code',
      filePath,
      content: parsed.content,
      mode: 'read',
      startLine: parsed.startLine,
      totalLines: parsed.totalLines,
      numLines: parsed.numLines,
      error: activity.error,
      // 若存在命令则透传（Codex 通过 shell 命令读取）
      command: input?._command as string | undefined,
    }
  }

  // Write 工具 → .md/.txt 走 Document 浮层（渲染 markdown），其余走 Code 浮层
  if (toolName === 'write') {
    const content = (input?.content as string) || rawContent
    const ext = filePath.split('.').pop()?.toLowerCase()
    if (ext === 'md' || ext === 'txt') {
      return {
        type: 'document',
        filePath,
        content,
        toolName: 'Write',
        error: activity.error,
      }
    }
    return {
      type: 'code',
      filePath,
      content,
      mode: 'write',
      error: activity.error,
    }
  }

  // Edit/Write 工具由点击处理器直接处理（多 diff 浮层）
  // 因此如果执行到这里，会回落到通用处理器

  // Bash 工具 → Terminal 浮层
  if (toolName === 'bash') {
    const parsed = parseBashResult(rawContent)
    return {
      type: 'terminal',
      command: (input?.command as string) || '',
      output: parsed.output,
      exitCode: parsed.exitCode,
      description: (input?.description as string) || activity.displayName || '',
      toolType: 'bash',
      error: activity.error,
    }
  }

  // Grep 工具 → Terminal 浮层
  if (toolName === 'grep') {
    const pattern = (input?.pattern as string) || ''
    const searchPath = (input?.path as string) || '.'
    const outputMode = (input?.output_mode as string) || 'files_with_matches'
    const parsed = parseGrepResult(rawContent, pattern, searchPath, outputMode)
    return {
      type: 'terminal',
      command: parsed.command,
      output: parsed.output,
      description: parsed.description,
      toolType: 'grep',
      error: activity.error,
    }
  }

  // Glob 工具 → Terminal 浮层
  if (toolName === 'glob') {
    const pattern = (input?.pattern as string) || '*'
    const searchPath = (input?.path as string) || '.'
    const parsed = parseGlobResult(rawContent, pattern, searchPath)
    return {
      type: 'terminal',
      command: parsed.command,
      output: parsed.output,
      description: parsed.description,
      toolType: 'glob',
      error: activity.error,
    }
  }

  // WebSearch 工具 → 带格式化链接的 Document 浮层
  if (toolName === 'websearch') {
    const formattedContent = parseWebSearchResult(rawContent)
    return {
      type: 'document',
      filePath: 'Web Search Results',
      content: formattedContent,
      toolName: 'WebSearch',
      error: activity.error,
    }
  }

  // LLM Query 工具（call_llm）→ 带输入 prompt + 输出响应的 Document 浮层
  if (toolName === 'mcp__session__call_llm') {
    const prompt = (input?.prompt as string) || ''
    const model = input?.model as string | undefined
    const systemPrompt = input?.systemPrompt as string | undefined
    const attachments = input?.attachments as unknown[] | undefined
    const outputFormat = input?.outputFormat as string | undefined
    const outputSchema = input?.outputSchema as Record<string, unknown> | undefined

    const sections: string[] = []

    // 输入段落
    sections.push('## Prompt')

    // 元数据（仅当存在时展示）
    const meta: string[] = []
    if (model) meta.push(`**Model:** ${model}`)
    if (systemPrompt) meta.push(`**System Prompt:** ${systemPrompt}`)
    if (outputFormat) meta.push(`**Output Format:** ${outputFormat}`)
    if (outputSchema) meta.push(`**Output Schema:**\n\`\`\`json\n${JSON.stringify(outputSchema, null, 2)}\n\`\`\``)
    if (attachments && attachments.length > 0) {
      const paths = attachments
        .map(a => typeof a === 'string' ? a : (a as { path: string }).path)
        .filter(Boolean)
      if (paths.length > 0) meta.push(`**Attachments:** ${paths.join(', ')}`)
    }
    if (meta.length > 0) {
      sections.push(meta.join('\n\n'))
    }

    sections.push(prompt)

    // 输出段落
    if (rawContent) {
      sections.push('---')
      sections.push('## Response')
      sections.push(rawContent)
    }

    return {
      type: 'document',
      content: sections.join('\n\n'),
      filePath: 'LLM Query',
      toolName: 'call_llm',
      error: activity.error,
    }
  }

  // 尝试为未知工具（MCP 工具、WebFetch 等）检测 JSON 内容
  // JSON 对象/数组使用交互式树形查看器，其他内容回落到通用展示
  const trimmedContent = rawContent.trim()
  if ((trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
      (trimmedContent.startsWith('[') && trimmedContent.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmedContent)
      return {
        type: 'json',
        data: parsed,
        rawContent: trimmedContent,
        title: activity.displayName || activity.toolName || 'JSON Result',
        error: activity.error,
      }
    } catch {
      // 非合法 JSON，回落到通用展示
    }
  }

  // 未知工具的兜底 - 纯文本/markdown 内容
  return {
    type: 'generic',
    content: rawContent || (input ? JSON.stringify(input, null, 2) : ''),
    title: activity.displayName || activity.toolName || 'Activity',
    error: activity.error,
  }
}

function normalizeToolCommandName(toolName?: string): string {
  const raw = toolName || 'tool'
  if (raw.startsWith('mcp__session__')) return raw.slice('mcp__session__'.length)
  if (raw.startsWith('mcp__workspace__')) return raw.slice('mcp__workspace__'.length)
  return raw
}

function formatCliValue(value: unknown): string {
  if (typeof value === 'string') {
    const needsQuoting = /\s|"|\\/.test(value)
    if (!needsQuoting) return value
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return JSON.stringify(value)
}

/** 根据工具名称 + 输入构建确定性、类 Bash 的命令预览。 */
export function formatToolCommandPreview(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolName) return undefined
  const normalized = normalizeToolCommandName(toolName)

  if (!input || Object.keys(input).length === 0) {
    return normalized
  }

  // 包装类命令直接透传原始 CLI 输入以获得最佳还原度。
  if (normalized === 'browser_tool' && typeof input.command === 'string' && input.command.trim()) {
    return input.command.trim()
  }

  const entries = Object.entries(input)
    .filter(([key, value]) => key !== '_intent' && key !== '_displayName' && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))

  const flags = entries.map(([key, value]) => {
    if (typeof value === 'boolean') return value ? `--${key}` : `--${key} false`
    return `--${key} ${formatCliValue(value)}`
  })

  return flags.length > 0 ? `${normalized} ${flags.join(' ')}` : normalized
}

/**
 * 从 activity 中提取一个或多个浮层卡片。
 *
 * 当前卡片：
 * - Input：toolInput（存在时）
 * - Output：解析后的工具结果/内容（有意义时）
 *
 * 这里有意返回数组，以便在不改变浮层契约的前提下
 * 支持未来的卡片类型。
 */
export function extractOverlayCards(activity: ActivityItem): OverlayCard[] {
  if (!activity) return []

  const cards: OverlayCard[] = []
  const input = activity.toolInput as Record<string, unknown> | undefined
  const hasInput = !!input && Object.keys(input).length > 0

  // Input 卡片（优先 JSON，通用兜底）
  let inputJson = ''
  const commandPreview = formatToolCommandPreview(activity.toolName, input)
  if (hasInput) {
    try {
      inputJson = JSON.stringify(input, null, 2)
      cards.push({
        id: 'input',
        label: 'Input',
        commandPreview,
        data: {
          type: 'json',
          data: input,
          rawContent: inputJson,
          title: `${activity.displayName || activity.toolName || 'Tool'} Input`,
        },
      })
    } catch {
      cards.push({
        id: 'input',
        label: 'Input',
        commandPreview,
        data: {
          type: 'generic',
          content: String(input),
          title: `${activity.displayName || activity.toolName || 'Tool'} Input`,
        },
      })
    }
  }

  // Output 卡片（始终存在以保证一致的 Input/Output 体验）
  const output = extractOverlayData(activity)
  const rawContent = (activity.content || '').trim()
  const isInputMirrorFallback =
    hasInput &&
    rawContent.length === 0 &&
    output?.type === 'generic' &&
    !!inputJson &&
    output.content.trim() === inputJson.trim()

  const outputData: OverlayData = isInputMirrorFallback
    ? {
        type: 'generic',
        content: 'No output captured for this tool call.',
        title: `${activity.displayName || activity.toolName || 'Tool'} Output`,
        error: activity.error,
      }
    : (output || {
      type: 'generic',
      content: rawContent || 'No output captured for this tool call.',
      title: `${activity.displayName || activity.toolName || 'Tool'} Output`,
      error: activity.error,
    })

  cards.push({
    id: 'output',
    label: 'Output',
    data: outputData,
  })

  // 最后兜底（保留以做防御性保护）
  if (cards.length === 0) {
    cards.push({
      id: 'output',
      label: 'Output',
      data: {
        type: 'generic',
        content: 'No output captured for this tool call.',
        title: activity.displayName || activity.toolName || 'Activity',
        error: activity.error,
      },
    })
  }

  return cards
}
