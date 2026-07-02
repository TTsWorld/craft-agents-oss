/**
 * Info_DataTable
 *
 * 为信息页增强的数据表格组件，内置搜索框、排序、过滤工具栏。
 * 底层封装了 shadcn 的 DataTable，并应用 Info 页面的统一样式。
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import type { ColumnDef } from '@tanstack/react-table'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

export interface Info_DataTableProps<TData, TValue> {
  /** TanStack Table 列定义 */
  columns: ColumnDef<TData, TValue>[]
  /** 表格数据 */
  data: TData[]
  /** 是否在工具栏显示搜索框：true 使用默认占位符，或传入配置 */
  searchable?: boolean | {
    /** 搜索框占位文本 */
    placeholder?: string
    /** 要搜索的列 ID；不传则使用全局搜索 */
    column?: string
  }
  /** 最大高度，超出后纵向滚动（与 Info_Markdown 类似） */
  maxHeight?: number
  /** 是否显示加载中状态 */
  loading?: boolean
  /** 错误提示文本 */
  error?: string
  /** 空状态内容 */
  emptyContent?: React.ReactNode
  /**
   * 悬浮操作按钮，渲染在表头右上方（例如全屏按钮）。
   * 外层容器使用 group 类时，可通过 group-hover 在 hover 时显示。
   */
  floatingAction?: React.ReactNode
  /** 启用树形 / 层级行（透传给 DataTable） */
  getSubRows?: (row: TData) => TData[] | undefined
  /** 额外的 className */
  className?: string
}

/**
 * Info_DataTable - 信息页增强数据表格
 *
 * @example
 * ```tsx
 * const columns: ColumnDef<ToolRow>[] = [
 *   {
 *     accessorKey: 'name',
 *     header: ({ column }) => <SortableHeader column={column} title="Name" />,
 *   },
 *   // 省略其他列
 * ]
 *
 * <Info_DataTable
 *   columns={columns}
 *   data={tools}
 *   searchable={{ placeholder: 'Search tools...' }}
 *   maxHeight={400}
 * />
 * ```
 */
export function Info_DataTable<TData, TValue>({
  columns,
  data,
  searchable = false,
  maxHeight,
  loading = false,
  error,
  emptyContent,
  floatingAction,
  getSubRows,
  className,
}: Info_DataTableProps<TData, TValue>) {
  const { t } = useTranslation()
  const [searchValue, setSearchValue] = React.useState('')

  // 把 searchable 属性统一解析为 searchConfig（null 表示不显示搜索框）
  const searchConfig = React.useMemo(() => {
    if (!searchable) return null
    if (searchable === true) {
      return { placeholder: t("common.search"), column: undefined }
    }
    return {
      placeholder: searchable.placeholder ?? t("common.search"),
      column: searchable.column,
    }
  }, [searchable, t])

  // 加载中状态：居中显示 spinner
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  // 错误状态：显示错误提示，对「source 需要认证」做特殊文案处理
  if (error) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        {error === 'Source requires authentication' ? (
          <span>{t('sourceInfo.authenticateToViewData')}</span>
        ) : (
          <span>{error}</span>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        // 外层容器隐藏横向溢出，避免 sticky 的悬浮按钮随表格内容一起横向滚动；
        // 真正的横向滚动交给内层 wrapper 独立处理。
        maxHeight && 'overflow-y-auto overflow-x-hidden',
        className
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {/* 悬浮按钮：sticky + float 定位，使其在滚动时停留在右上角。
          不用 absolute 是因为父级 SettingsCard 有 overflow-hidden，会裁剪 absolute 元素；
          sticky 能兼容 overflow 容器。高度 0 避免额外占据布局空间。 */}
      {floatingAction && (
        <div className="sticky top-2.5 float-right mr-1.5 z-20 h-0">
          {floatingAction}
        </div>
      )}

      {/* 内层 wrapper 独立处理横向溢出，表格横向滚动时不会拖动悬浮按钮。 */}
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={data}
          globalFilter={searchConfig?.column ? undefined : searchValue}
          filterColumn={searchConfig?.column}
          filterValue={searchConfig?.column ? searchValue : undefined}
          emptyContent={emptyContent}
          getSubRows={getSubRows}
          noBorder
          noWrapper
        />
      </div>
    </div>
  )
}

// 为方便调用者，从这里直接导出 SortableHeader 和 ColumnDef 类型
export { SortableHeader } from '@/components/ui/data-table'
export type { ColumnDef } from '@tanstack/react-table'
