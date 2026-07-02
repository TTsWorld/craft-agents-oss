/**
 * DataTable — 基于 @tanstack/react-table 的数据表格。
 *
 * 支持排序、过滤、分页、列宽调整、树形展开等常见表格能力。
 */
import * as React from 'react'
import type {
  ColumnDef,
  ColumnFiltersState,
  ColumnSizingState,
  SortingState,
  PaginationState,
  ExpandedState,
  Column,
  Row,
  Table as TableInstance,
} from '@tanstack/react-table'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getExpandedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  /** 全局过滤值（搜索所有列） */
  globalFilter?: string
  /** 要过滤的列 ID */
  filterColumn?: string
  /** 列过滤值 */
  filterValue?: string
  /** 外层容器自定义 className */
  className?: string
  /** 空状态内容 */
  emptyContent?: React.ReactNode
  /** 表格实例准备就绪时的回调，方便外部控制 */
  onTableReady?: (table: TableInstance<TData>) => void
  /** 去掉边框包装（父组件已提供边框时） */
  noBorder?: boolean
  /** 去掉表格 overflow 包装（粘性表头需要） */
  noWrapper?: boolean
  /** 是否启用分页 */
  pagination?: boolean
  /** 分页页大小（默认 50） */
  pageSize?: number
  /**
   * 启用树形/层级行。传入返回子行的函数。
   * 设置后行可展开/折叠，默认全部展开。
   */
  getSubRows?: (row: TData) => TData[] | undefined
  /** 初始展开状态（默认在提供 getSubRows 时全部展开） */
  defaultExpanded?: boolean
}

/** DataTable：函数 */
export function DataTable<TData, TValue>({
  columns,
  data,
  globalFilter,
  filterValue,
  filterColumn,
  className,
  emptyContent,
  onTableReady,
  noBorder = false,
  noWrapper = false,
  pagination: paginationEnabled = false,
  pageSize = 50,
  getSubRows,
  defaultExpanded = true,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({})
  const [internalGlobalFilter, setInternalGlobalFilter] = React.useState('')
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  })
  // 树形展开状态：提供 getSubRows 且默认展开时设为全部展开
  const [expanded, setExpanded] = React.useState<ExpandedState>(
    getSubRows && defaultExpanded ? true : {}
  )

  // 同步外部全局过滤，并切换过滤时回到第一页
  React.useEffect(() => {
    if (globalFilter !== undefined) {
      setInternalGlobalFilter(globalFilter)
      if (paginationEnabled) {
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
      }
    }
  }, [globalFilter, paginationEnabled])

  // 列过滤变化时同步状态
  React.useEffect(() => {
    if (filterColumn && filterValue !== undefined) {
      setColumnFilters([{ id: filterColumn, value: filterValue }])
    } else if (filterColumn) {
      setColumnFilters([])
    }
  }, [filterValue, filterColumn])

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(paginationEnabled && { getPaginationRowModel: getPaginationRowModel() }),
    // 仅在提供 getSubRows 时启用树形展开
    ...(getSubRows && { getExpandedRowModel: getExpandedRowModel(), getSubRows }),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    onGlobalFilterChange: setInternalGlobalFilter,
    ...(paginationEnabled && { onPaginationChange: setPagination }),
    ...(getSubRows && { onExpandedChange: setExpanded }),
    globalFilterFn: 'includesString',
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    state: {
      sorting,
      columnFilters,
      columnSizing,
      globalFilter: internalGlobalFilter,
      ...(paginationEnabled && { pagination }),
      ...(getSubRows && { expanded }),
    },
  })

  // 把表格实例暴露给父组件
  React.useEffect(() => {
    onTableReady?.(table)
  }, [table, onTableReady])

  const tableContent = (
    <Table noWrapper={noWrapper}>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const meta = header.column.columnDef.meta as
                | { fillWidth?: boolean; truncate?: boolean; maxWidth?: string }
                | undefined
              const minSize = header.column.columnDef.minSize
              const currentSize = header.getSize()
              // 只有用户调整过列宽或存在 minSize 时才写死宽度
              const hasResized = columnSizing[header.id] !== undefined
              return (
                <TableHead
                  key={header.id}
                  className={cn(meta?.fillWidth && 'w-full')}
                  style={{
                    width: hasResized ? currentSize : undefined,
                    minWidth: minSize,
                    maxWidth: meta?.maxWidth,
                  }}
                >
                  <div className="flex items-center">
                    <div className="flex-1">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </div>
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className={cn(
                          'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none',
                          'opacity-0 hover:opacity-100 transition-opacity',
                          'bg-border',
                          header.column.getIsResizing() && 'opacity-100 bg-accent'
                        )}
                      />
                    )}
                  </div>
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows?.length ? (
          table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() && 'selected'}
            >
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as
                  | { fillWidth?: boolean; truncate?: boolean; maxWidth?: string }
                  | undefined
                const minSize = cell.column.columnDef.minSize
                const currentSize = cell.column.getSize()
                const hasResized = columnSizing[cell.column.id] !== undefined
                return (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      meta?.fillWidth && 'w-full',
                      meta?.truncate && 'overflow-hidden'
                    )}
                    style={{
                      width: hasResized ? currentSize : undefined,
                      minWidth: minSize,
                      maxWidth: meta?.maxWidth,
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                )
              })}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell
              colSpan={columns.length}
              className="h-24 text-center"
            >
              {emptyContent ?? 'No results.'}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )

  const paginationControls = paginationEnabled && table.getPageCount() > 1 && (
    <div className="flex items-center justify-between px-2 py-3 border-t border-border">
      <div className="text-sm text-muted-foreground">
        {table.getFilteredRowModel().rows.length} total
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        >
          Next
        </Button>
      </div>
    </div>
  )

  if (noBorder) {
    return (
      <div className={cn('w-full', className)}>
        {tableContent}
        {paginationControls}
      </div>
    )
  }

  return (
    <div className={cn('w-full', className)}>
      <div className="rounded-md border">
        {tableContent}
        {paginationControls}
      </div>
    </div>
  )
}

/**
 * 可排序列头组件。
 * 在列定义中使用：header: ({ column }) => <SortableHeader column={column} title="名称" />
 */
interface SortableHeaderProps<TData, TValue> {
  column: Column<TData, TValue>
  title: string
  className?: string
}

/** 可排序列头 */
export function SortableHeader<TData, TValue>({
  column,
  title,
  className,
}: SortableHeaderProps<TData, TValue>) {
  return (
    <Button
      variant="ghost"
      onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
      className={cn('w-full justify-start p-1.5 pl-2.5', className)}
    >
      {title}
    </Button>
  )
}

export type { ColumnDef, Column, Row, TableInstance }
