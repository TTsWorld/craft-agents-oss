/**
 * 终端输出的 ANSI 转义码解析工具。
 */

/**
 * ANSI 颜色码到 CSS 颜色的映射
 * 同时支持前景色（30-37、90-97）和背景色（40-47、100-107）
 */
export const ANSI_COLORS: Record<number, string> = {
  // 标准前景色（30-37）
  30: '#1a1a1a', // 黑色
  31: '#ef4444', // 红色
  32: '#22c55e', // 绿色
  33: '#eab308', // 黄色
  34: '#3b82f6', // 蓝色
  35: '#a855f7', // 品红
  36: '#06b6d4', // 青色
  37: '#e4e4e4', // 白色
  // 亮色前景色（90-97）
  90: '#666666', // 亮黑（灰色）
  91: '#f87171', // 亮红
  92: '#4ade80', // 亮绿
  93: '#facc15', // 亮黄
  94: '#60a5fa', // 亮蓝
  95: '#c084fc', // 亮品红
  96: '#22d3ee', // 亮青
  97: '#ffffff', // 亮白
  // 标准背景色（40-47）
  40: '#1a1a1a', // 黑色
  41: '#ef4444', // 红色
  42: '#22c55e', // 绿色
  43: '#eab308', // 黄色
  44: '#3b82f6', // 蓝色
  45: '#a855f7', // 品红
  46: '#06b6d4', // 青色
  47: '#e4e4e4', // 白色
  // 亮色背景色（100-107）
  100: '#666666',
  101: '#f87171',
  102: '#4ade80',
  103: '#facc15',
  104: '#60a5fa',
  105: '#c084fc',
  106: '#22d3ee',
  107: '#ffffff',
}

export interface AnsiSpan {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
}

/**
 * 解析 ANSI 转义码并转换为带样式的 span
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const result: AnsiSpan[] = []
  // 匹配 ANSI 转义序列：ESC[...m
  const regex = /\x1b\[([0-9;]*)m/g
  let lastIndex = 0
  let currentFg: string | undefined
  let currentBg: string | undefined
  let currentBold = false

  let match
  while ((match = regex.exec(input)) !== null) {
    // 添加该转义序列之前的文本
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index)
      if (text) {
        result.push({ text, fg: currentFg, bg: currentBg, bold: currentBold })
      }
    }

    // 解析 SGR 码
    const codes = (match[1] || '').split(';').map(c => parseInt(c, 10) || 0)
    for (const code of codes) {
      if (code === 0) {
        // 重置
        currentFg = undefined
        currentBg = undefined
        currentBold = false
      } else if (code === 1) {
        // 加粗
        currentBold = true
      } else if (code === 39) {
        // 默认前景色
        currentFg = undefined
      } else if (code === 49) {
        // 默认背景色
        currentBg = undefined
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        // 前景色
        currentFg = ANSI_COLORS[code]
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        // 背景色
        currentBg = ANSI_COLORS[code]
      }
    }

    lastIndex = match.index + match[0].length
  }

  // 添加剩余文本
  if (lastIndex < input.length) {
    const text = input.slice(lastIndex)
    if (text) {
      result.push({ text, fg: currentFg, bg: currentBg, bold: currentBold })
    }
  }

  return result
}

/**
 * 从文本中去除 ANSI 转义码（用于复制）
 */
export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * 判断输出是否疑似 grep 内容输出（带行号）
 * 模式：以 "123:"（匹配行）或 "123-"（上下文行）开头的行
 */
export function isGrepContentOutput(output: string): boolean {
  const lines = output.split('\n').slice(0, 5) // 检查前 5 行
  return lines.some(line => /^\d+[:\-]/.test(line))
}

export interface GrepLine {
  lineNum: string
  isMatch: boolean
  content: string
}

/**
 * 将 grep 内容输出解析为结构化行
 */
export function parseGrepOutput(output: string): GrepLine[] {
  return output.split('\n').map(line => {
    const match = line.match(/^(\d+)([:])(.*)$/)
    const context = line.match(/^(\d+)(-)(.*)$/)
    if (match && match[1] && match[3] !== undefined) {
      return { lineNum: match[1], isMatch: true, content: match[3] }
    } else if (context && context[1] && context[3] !== undefined) {
      return { lineNum: context[1], isMatch: false, content: context[3] }
    }
    return { lineNum: '', isMatch: false, content: line }
  })
}
