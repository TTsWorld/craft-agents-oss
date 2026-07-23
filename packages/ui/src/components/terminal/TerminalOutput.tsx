/**
 * TerminalOutput - 终端风格的命令输出展示组件
 *
 * 跨平台组件，用于展示终端输出，具备：
 * - ANSI 颜色码支持
 * - grep 输出行号高亮
 * - 亮色/暗色主题支持
 * - 复制功能
 */

import * as React from 'react'
import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Copy, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { parseAnsi, stripAnsi, isGrepContentOutput, parseGrepOutput } from './ansi-parser'

export type ToolType = 'bash' | 'grep' | 'glob'

export interface TerminalOutputProps {
  /** 执行的命令 */
  command: string
  /** 命令的输出内容 */
  output: string
  /** 退出码（0 = 成功） */
  exitCode?: number
  /** 工具类型，用于展示样式 */
  toolType?: ToolType
  /** 可选的命令用途说明 */
  description?: string
  /** 主题模式 */
  theme?: 'light' | 'dark'
  /** 附加的类名 */
  className?: string
}

/**
 * TerminalOutput - 以 ANSI 颜色展示终端命令及输出
 */
export function TerminalOutput({
  command,
  output,
  exitCode,
  toolType = 'bash',
  description,
  theme = 'light',
  className,
}: TerminalOutputProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<'command' | 'output' | null>(null)

  const isDark = theme === 'dark'

  // 随主题变化的内部元素颜色（外层背景继承自浮层的 bg-background）
  const textColor = isDark ? '#e4e4e4' : '#1a1a1a'
  const mutedColor = isDark ? '#888888' : '#666666'
  const matchColor = '#22c55e' // 绿色，用于 grep 匹配项
  const cmdColor = isDark ? '#60a5fa' : '#2563eb' // 蓝色，用于命令
  const codeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'
  const outputBg = isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.03)'

  // 复制到剪贴板（去除 ANSI 码以获得纯净文本）
  const copyToClipboard = useCallback(async (text: string, type: 'command' | 'output') => {
    try {
      await navigator.clipboard.writeText(stripAnsi(text))
      setCopied(type)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [])

  // 出于性能考虑，对 ANSI 解析结果进行记忆化
  const parsedOutput = useMemo(() => {
    if (!output) return []
    return parseAnsi(output)
  }, [output])

  // 判断输出是否疑似 grep 内容输出
  const isGrepOutput = useMemo(() => {
    if (!output) return false
    return isGrepContentOutput(output)
  }, [output])

  // 若适用，则解析 grep 输出
  const grepLines = useMemo(() => {
    if (!isGrepOutput || !output) return []
    return parseGrepOutput(output)
  }, [isGrepOutput, output])

  return (
    <div
      className={cn('h-full w-full overflow-auto px-5 py-4 font-mono text-sm', className)}
      style={{ fontFamily: '"JetBrains Mono", monospace' }}
    >
      {/* 命令区块 */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs" style={{ color: mutedColor }}>
            <Terminal className="w-3 h-3" />
            <span>Command</span>
          </div>
          <button
            onClick={() => copyToClipboard(command, 'command')}
            className={cn(
              'p-1 rounded transition-colors',
              isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
            )}
            title={copied === 'command' ? t('common.copied') : t('terminal.copyCommand')}
          >
            {copied === 'command' ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" style={{ color: mutedColor }} />
            )}
          </button>
        </div>
        <div className="overflow-x-auto">
          <code className="text-foreground">{command}</code>
        </div>
      </div>

      {/* 输出区块 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs" style={{ color: mutedColor }}>
            <Terminal className="w-3 h-3" />
            <span>{t('terminal.output')}</span>
            {exitCode !== undefined && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px]"
                style={{
                  backgroundColor: exitCode === 0 ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                  color: exitCode === 0 ? 'rgb(34, 197, 94)' : 'rgb(239, 68, 68)',
                }}
              >
                exit {exitCode}
              </span>
            )}
          </div>
          <button
            onClick={() => copyToClipboard(output, 'output')}
            className={cn(
              'p-1 rounded transition-colors',
              isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
            )}
            title={copied === 'output' ? t('common.copied') : t('terminal.copyOutput')}
          >
            {copied === 'output' ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" style={{ color: mutedColor }} />
            )}
          </button>
        </div>
        <pre
          className="overflow-auto"
          style={{ color: textColor }}
        >
          {/* 带行号高亮的 grep 输出 */}
          {isGrepOutput && grepLines.length > 0 ? (
            <div className="space-y-0">
              {grepLines.map((line, i) => (
                <div
                  key={i}
                  className="flex"
                  style={{
                    backgroundColor: line.isMatch ? 'rgba(34, 197, 94, 0.08)' : undefined,
                  }}
                >
                  {/* 行号 */}
                  {line.lineNum && (
                    <span
                      className="select-none pr-3 text-right shrink-0"
                      style={{
                        color: line.isMatch ? matchColor : mutedColor,
                        minWidth: '3rem',
                      }}
                    >
                      {line.lineNum}
                      <span style={{ color: line.isMatch ? matchColor : (isDark ? '#444444' : '#cccccc') }}>
                        {line.isMatch ? ':' : '-'}
                      </span>
                    </span>
                  )}
                  {/* 内容 */}
                  <span
                    className="whitespace-pre-wrap break-words"
                    style={{ color: line.isMatch ? textColor : mutedColor }}
                  >
                    {line.content}
                  </span>
                </div>
              ))}
            </div>
          ) : parsedOutput.length > 0 ? (
            /* ANSI 着色输出 */
            <div className="whitespace-pre-wrap break-words">
              {parsedOutput.map((span, i) => (
                <span
                  key={i}
                  style={{
                    color: span.fg,
                    backgroundColor: span.bg,
                    fontWeight: span.bold ? 'bold' : undefined,
                    // 为背景色添加内边距
                    padding: span.bg ? '0 2px' : undefined,
                    borderRadius: span.bg ? '2px' : undefined,
                  }}
                >
                  {span.text}
                </span>
              ))}
            </div>
          ) : (
            <span style={{ color: mutedColor }}>(no output)</span>
          )}
        </pre>
      </div>
    </div>
  )
}
