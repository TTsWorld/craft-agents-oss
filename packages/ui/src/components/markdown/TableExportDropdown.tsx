/**
 * TableExportDropdown - 用于 datatable 和 spreadsheet 浮层的复制/导出下拉菜单
 *
 * 使用共享的 StyledDropdown 组件,以与应用其余部分保持一致样式。
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Copy, Download, FileText } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'
import { tableToMarkdown, tableToCsv, tableToXlsx, type ExportColumn } from './table-export'

export interface TableExportDropdownProps {
  columns: ExportColumn[]
  rows: Record<string, unknown>[]
  /** XLSX 下载的文件名(不含扩展名) */
  filename: string
}

export function TableExportDropdown({ columns, rows, filename }: TableExportDropdownProps) {
  const { t } = useTranslation()
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null)

  const handleExport = useCallback(async (format: 'markdown' | 'csv' | 'xlsx') => {
    if (format === 'xlsx') {
      tableToXlsx(columns, rows, filename)
      return
    }
    const text = format === 'markdown' ? tableToMarkdown(columns, rows) : tableToCsv(columns, rows)
    try {
      await navigator.clipboard.writeText(text)
      setCopiedFormat(format)
      setTimeout(() => setCopiedFormat(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [columns, rows, filename])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 px-2 py-1.5 rounded-[6px] cursor-pointer select-none',
            'bg-background shadow-minimal',
            'opacity-70 hover:opacity-100 transition-opacity',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
          title={t('table.exportTable')}
        >
          <Copy className="w-4 h-4" />
          <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent sideOffset={6} align="end" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
        <StyledDropdownMenuItem onSelect={() => handleExport('markdown')}>
          {copiedFormat === 'markdown' ? <Check className="text-success" /> : <FileText />}
          {t('table.copyAsMarkdown')}
        </StyledDropdownMenuItem>
        <StyledDropdownMenuItem onSelect={() => handleExport('csv')}>
          {copiedFormat === 'csv' ? <Check className="text-success" /> : <FileText />}
          {t('table.copyAsCsv')}
        </StyledDropdownMenuItem>
        <StyledDropdownMenuItem onSelect={() => handleExport('xlsx')}>
          <Download />
          {t('table.downloadAsXlsx')}
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
