/**
 * 用于展示命令结果的终端输出组件。
 */

export { TerminalOutput, type TerminalOutputProps, type ToolType } from './TerminalOutput'
export {
  parseAnsi,
  stripAnsi,
  isGrepContentOutput,
  parseGrepOutput,
  ANSI_COLORS,
  type AnsiSpan,
  type GrepLine,
} from './ansi-parser'
