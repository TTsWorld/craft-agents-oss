/**
 * PermissionsDataTable
 *
 * 用于展示 source 权限规则的数据表格。
 * 支持模式搜索、排序、最大高度滚动、全屏查看。
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef } from '@tanstack/react-table'
import { Maximize2 } from 'lucide-react'
import { Info_DataTable, SortableHeader } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { Info_StatusBadge } from './Info_StatusBadge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { DataTableOverlay } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import { toast } from 'sonner'

/** 权限访问类型：允许 / 阻止 */
export type PermissionAccess = 'allowed' | 'blocked'
/** 权限规则类型：tool / bash / api / mcp */
export type PermissionType = 'tool' | 'bash' | 'api' | 'mcp'

/** 权限规则行数据 */
export interface PermissionRow {
  /** 访问控制 */
  access: PermissionAccess
  /** 规则类型 */
  type: PermissionType
  /** 匹配模式（通常是 glob 或正则） */
  pattern: string
  /** 规则备注 */
  comment?: string | null
}

interface PermissionsDataTableProps {
  data: PermissionRow[]
  /** 是否隐藏类型列（某些 MCP source 只展示 pattern 与 comment） */
  hideTypeColumn?: boolean
  /** 是否显示搜索框 */
  searchable?: boolean
  /** 最大高度，超出后纵向滚动 */
  maxHeight?: number
  /** 是否启用全屏按钮（hover 时显示 Maximize2 图标） */
  fullscreen?: boolean
  /** 全屏弹窗的标题 */
  fullscreenTitle?: string
  className?: string
}

/**
 * PatternBadge - 可点击的模式徽章，过长时自动截断并显示 tooltip。
 * - 最大宽度 240px，使用 CSS 省略号截断；
 * - 模式长度 >= 30 时显示 tooltip；
 * - 点击可复制到剪贴板，并弹出 toast 提示。
 */
function PatternBadge({ pattern }: { pattern: string }) {
  const { t } = useTranslation()
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(pattern)
      toast.success(t('toast.patternCopied'))
    } catch {
      toast.error(t('toast.failedToCopyPattern'))
    }
  }

  const badge = (
    <button type="button" onClick={handleClick} className="text-left">
      <Info_Badge color="muted" className="font-mono select-none">
        <span className="block overflow-hidden whitespace-nowrap text-ellipsis max-w-[240px]">
          {pattern}
        </span>
      </Info_Badge>
    </button>
  )

  // 只有较长的模式（>= 30 字符）才显示 tooltip
  if (pattern.length >= 30) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="font-mono max-w-md break-all">{pattern}</TooltipContent>
      </Tooltip>
    )
  }

  return badge
}

// 包含「类型」列的列定义
function getColumnsWithType(t: TFunction): ColumnDef<PermissionRow>[] {
  return [
    {
      accessorKey: 'access',
      header: ({ column }) => <SortableHeader column={column} title={t("table.access")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_StatusBadge status={row.original.access} className="whitespace-nowrap" />
        </div>
      ),
      minSize: 80,
    },
    {
      accessorKey: 'type',
      header: ({ column }) => <SortableHeader column={column} title={t("common.type")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_Badge color="muted" className="capitalize whitespace-nowrap">
            {row.original.type}
          </Info_Badge>
        </div>
      ),
      minSize: 80,
    },
    {
      accessorKey: 'pattern',
      header: ({ column }) => <SortableHeader column={column} title={t("table.pattern")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <PatternBadge pattern={row.original.pattern} />
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'comment',
      accessorKey: 'comment',
      header: () => <span className="p-1.5 pl-2.5">{t("table.comment")}</span>,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 min-w-0">
          <span className="truncate block">
            {row.original.comment || '—'}
          </span>
        </div>
      ),
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

// 隐藏「类型」列后的列定义
function getColumnsWithoutType(t: TFunction): ColumnDef<PermissionRow>[] {
  return [
    {
      accessorKey: 'access',
      header: ({ column }) => <SortableHeader column={column} title={t("table.access")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_StatusBadge status={row.original.access} className="whitespace-nowrap" />
        </div>
      ),
      minSize: 80,
    },
    {
      accessorKey: 'pattern',
      header: ({ column }) => <SortableHeader column={column} title={t("table.pattern")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <PatternBadge pattern={row.original.pattern} />
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'comment',
      accessorKey: 'comment',
      header: () => <span className="p-1.5 pl-2.5">{t("table.comment")}</span>,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 min-w-0">
          <span className="truncate block">
            {row.original.comment || '—'}
          </span>
        </div>
      ),
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

export function PermissionsDataTable({
  data,
  hideTypeColumn = false,
  searchable = false,
  maxHeight = 400,
  fullscreen = false,
  fullscreenTitle = 'Permissions',
  className,
}: PermissionsDataTableProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { isDark } = useTheme()
  const columnsWithType = useMemo(() => getColumnsWithType(t), [t])
  const columnsWithoutType = useMemo(() => getColumnsWithoutType(t), [t])
  const columns = hideTypeColumn ? columnsWithoutType : columnsWithType

  // 全屏按钮（hover 时显示）
  const fullscreenButton = fullscreen ? (
    <button
      onClick={() => setIsFullscreen(true)}
      className={cn(
        'p-1 rounded-[6px] transition-all',
        'opacity-0 group-hover:opacity-100',
        'bg-background/80 backdrop-blur-sm shadow-minimal',
        'text-muted-foreground/50 hover:text-foreground',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100'
      )}
      title={t("table.viewFullscreen")}
    >
      <Maximize2 className="w-3.5 h-3.5" />
    </button>
  ) : undefined

  return (
    <>
      <Info_DataTable
        columns={columns}
        data={data}
        searchable={searchable ? { placeholder: t("table.searchPatterns") } : false}
        maxHeight={maxHeight}
        emptyContent={t("table.noPermissionsConfigured")}
        floatingAction={fullscreenButton}
        className={cn(fullscreen && 'group', className)}
      />

      {/* 全屏弹窗 overlay：移除滚动限制后再次渲染表格 */}
      {fullscreen && (
        <DataTableOverlay
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          title={fullscreenTitle}
          subtitle={t("table.ruleCount", { count: data.length })}
          theme={isDark ? 'dark' : 'light'}
        >
          <Info_DataTable
            columns={columns}
            data={data}
            searchable={searchable ? { placeholder: t("table.searchPatterns") } : false}
            emptyContent={t("table.noPermissionsConfigured")}
          />
        </DataTableOverlay>
      )}
    </>
  )
}
