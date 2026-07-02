/**
 * ToolsDataTable
 *
 * 用于展示 MCP（Model Context Protocol）工具的表格组件。
 * 支持搜索、排序、最大高度滚动，由 Info_DataTable 提供底层能力。
 */

import * as React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef } from '@tanstack/react-table'
import { Info_DataTable, SortableHeader } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { Info_StatusBadge } from './Info_StatusBadge'

/** MCP 工具权限：允许调用 / 需要询问 */
export type ToolPermission = 'allowed' | 'requires-permission'

/** MCP 工具行数据类型 */
export interface ToolRow {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description: string
  /** 工具权限状态 */
  permission: ToolPermission
}

interface ToolsDataTableProps {
  data: ToolRow[]
  /** 是否显示加载中 spinner */
  loading?: boolean
  /** 错误提示文本 */
  error?: string
  /** 最大高度，超出后纵向滚动（默认 400） */
  maxHeight?: number
  className?: string
}

/** 构造 TanStack Table 的列定义 */
function getColumns(t: TFunction): ColumnDef<ToolRow>[] {
  return [
    {
      accessorKey: 'permission',
      header: ({ column }) => <SortableHeader column={column} title={t("table.access")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_StatusBadge status={row.original.permission} className="whitespace-nowrap" />
        </div>
      ),
      minSize: 80,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => <SortableHeader column={column} title={t("table.tool")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_Badge color="muted" className="whitespace-nowrap">
            {row.original.name}
          </Info_Badge>
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'description',
      accessorKey: 'description',
      header: () => <span className="p-1.5 pl-2.5">{t("common.description")}</span>,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 min-w-0">
          <span className="truncate block">{row.original.description}</span>
        </div>
      ),
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

export function ToolsDataTable({
  data,
  loading,
  error,
  maxHeight = 400,
  className,
}: ToolsDataTableProps) {
  const { t } = useTranslation()
  const columns = useMemo(() => getColumns(t), [t])

  return (
    <Info_DataTable
      columns={columns}
      data={data}
      loading={loading}
      error={error}
      maxHeight={maxHeight}
      emptyContent={t("table.noToolsAvailable")}
      className={className}
    />
  )
}
