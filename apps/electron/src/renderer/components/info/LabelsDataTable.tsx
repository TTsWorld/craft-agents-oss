/**
 * LabelsDataTable
 *
 * 用于展示标签配置的树形表格，利用 TanStack Table 内置的展开/折叠能力渲染层级。
 * 列：颜色、名称（缩进 + 箭头）、值类型。
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef, Row } from '@tanstack/react-table'
import { ChevronRight, Maximize2 } from 'lucide-react'
import { Info_DataTable, SortableHeader } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { DataTableOverlay } from '@craft-agent/ui'
import { LabelIcon } from '@/components/ui/label-icon'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import type { LabelConfig } from '@craft-agent/shared/labels'

interface LabelsDataTableProps {
  /** 标签树（根节点，可能包含嵌套 children） */
  data: LabelConfig[]
  /** 是否显示搜索框 */
  searchable?: boolean
  /** 最大高度，超出后纵向滚动 */
  maxHeight?: number
  /** 是否启用全屏按钮 */
  fullscreen?: boolean
  /** 全屏弹窗的标题 */
  fullscreenTitle?: string
  className?: string
}

/**
 * ExpandableNameCell - 渲染可展开的标签名称单元格。
 * 根据节点深度缩进，父节点显示可旋转的展开/折叠箭头。
 */
function ExpandableNameCell({ row }: { row: Row<LabelConfig> }) {
  const canExpand = row.getCanExpand()
  const isExpanded = row.getIsExpanded()

  return (
    <div
      className="flex items-center gap-1.5 p-1.5 pl-2.5"
      // 根据节点深度缩进：每层 16px
      style={{ paddingLeft: `${row.depth * 16 + 10}px` }}
    >
      {/* 父节点显示展开/折叠箭头 */}
      {canExpand ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            row.toggleExpanded()
          }}
          className="p-0.5 rounded hover:bg-foreground/5 transition-colors"
        >
          <ChevronRight
            className={cn(
              'w-3 h-3 text-muted-foreground transition-transform duration-150',
              isExpanded && 'rotate-90'
            )}
          />
        </button>
      ) : (
        // 占位元素，保持叶子节点与父节点的水平对齐
        <span className="w-4" />
      )}
      <span className="text-sm truncate">{row.original.name}</span>
    </div>
  )
}

// 标签树表格的列定义
function getColumns(t: TFunction): ColumnDef<LabelConfig>[] {
  return [
    {
      id: 'color',
      header: () => <span className="p-1.5 pl-2.5">{t("common.color")}</span>,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <LabelIcon
            label={row.original}
            size="sm"
            hasChildren={!!row.original.children?.length}
          />
        </div>
      ),
      minSize: 60,
      maxSize: 60,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => <SortableHeader column={column} title={t("common.name")} />,
      cell: ({ row }) => <ExpandableNameCell row={row} />,
      meta: { fillWidth: true },
    },
    {
      id: 'valueType',
      accessorKey: 'valueType',
      header: ({ column }) => <SortableHeader column={column} title={t("common.type")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          {row.original.valueType ? (
            <Info_Badge color="muted" className="capitalize whitespace-nowrap">
              {t(`sidebar.labelValueType.${row.original.valueType}`)}
            </Info_Badge>
          ) : (
            <span className="text-muted-foreground/50 text-sm">—</span>
          )}
        </div>
      ),
      minSize: 120,
    },
  ]
}

/**
 * 从 LabelConfig 中提取子节点，用于树形展开。
 * 没有子节点时返回 undefined，TanStack Table 会将其识别为叶子节点。
 */
function getSubRows(row: LabelConfig): LabelConfig[] | undefined {
  return row.children?.length ? row.children : undefined
}

export function LabelsDataTable({
  data,
  searchable = false,
  maxHeight = 400,
  fullscreen = false,
  fullscreenTitle = 'Labels',
  className,
}: LabelsDataTableProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { isDark } = useTheme()
  const columns = useMemo(() => getColumns(t), [t])

  // 全屏按钮（外层有 group 类时 hover 显示）
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

  // 递归统计所有标签数量，用于全屏弹窗副标题
  const countLabels = (labels: LabelConfig[]): number =>
    labels.reduce((sum, l) => sum + 1 + countLabels(l.children || []), 0)
  const totalCount = countLabels(data)

  return (
    <>
      <Info_DataTable
        columns={columns}
        data={data}
        searchable={searchable ? { placeholder: t("table.searchLabels") } : false}
        maxHeight={maxHeight}
        emptyContent={t("table.noLabelsConfigured")}
        floatingAction={fullscreenButton}
        className={cn(fullscreen && 'group', className)}
        getSubRows={getSubRows}
      />

      {/* 全屏弹窗 overlay */}
      {fullscreen && (
        <DataTableOverlay
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          title={fullscreenTitle}
          subtitle={t("table.labelCount", { count: totalCount })}
          theme={isDark ? 'dark' : 'light'}
        >
          <Info_DataTable
            columns={columns}
            data={data}
            searchable={searchable ? { placeholder: t("table.searchLabels") } : false}
            emptyContent={t("table.noLabelsConfigured")}
            getSubRows={getSubRows}
          />
        </DataTableOverlay>
      )}
    </>
  )
}
