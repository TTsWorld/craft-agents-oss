/**
 * Calendar — 基于 react-day-picker v9 的日期选择日历。
 *
 * 改编自官方 shadcn/ui Calendar 组件。
 * 支持单选/范围选择，以及月份/年份下拉导航。
 */

import * as React from 'react'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { DayButton, DayPicker, getDefaultClassNames } from 'react-day-picker'

import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

/** 日历组件。 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  formatters,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      captionLayout={captionLayout}
      formatters={{
        // 下拉框中显示月份简写（Jan、Feb...）
        formatMonthDropdown: (date) =>
          date.toLocaleString('default', { month: 'short' }),
        ...formatters,
      }}
      className={cn(
        'bg-background p-3 [--cell-size:2rem]',
        className
      )}
      classNames={{
        root: cn('w-full', defaultClassNames.root),
        months: cn(
          'relative flex flex-col gap-4 md:flex-row',
          defaultClassNames.months
        ),
        month: cn('relative flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn(
          'absolute inset-x-0 top-1.5 flex h-[--cell-size] w-full items-center justify-between gap-1',
          defaultClassNames.nav
        ),
        button_previous: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50',
          defaultClassNames.button_previous
        ),
        button_next: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50',
          defaultClassNames.button_next
        ),
        month_caption: cn(
          'flex h-[--cell-size] w-full items-center justify-center px-[--cell-size]',
          defaultClassNames.month_caption
        ),
        // 月份/年份下拉选择器容器
        dropdowns: cn(
          'flex h-[--cell-size] w-full items-center justify-center gap-1.5 text-sm font-medium',
          defaultClassNames.dropdowns
        ),
        // 单个下拉包装器（月份或年份）
        dropdown_root: cn(
          'relative rounded-[5px] shadow-minimal',
          defaultClassNames.dropdown_root
        ),
        // 原生 <select> 视觉上隐藏，caption_label 展示当前选中的值
        dropdown: cn('absolute inset-0 opacity-0 cursor-pointer', defaultClassNames.dropdown),
        caption_label: cn(
          'select-none font-medium',
          captionLayout === 'label'
            ? 'text-sm'
            : 'flex h-7 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:text-foreground/40 [&>svg]:size-3.5',
          defaultClassNames.caption_label
        ),
        table: 'w-full border-collapse',
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn(
          'text-foreground/40 flex-1 select-none rounded-md text-[0.8rem] font-normal',
          defaultClassNames.weekday
        ),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        day: cn(
          'relative flex-1 p-0 text-center select-none',
          defaultClassNames.day
        ),
        today: cn(
          'bg-foreground/5 rounded-md',
          defaultClassNames.today
        ),
        outside: cn(
          'text-foreground/25 aria-selected:text-foreground/40',
          defaultClassNames.outside
        ),
        disabled: cn(
          'text-foreground/25 opacity-50',
          defaultClassNames.disabled
        ),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === 'left') {
            return <ChevronLeftIcon className={cn('size-4', className)} {...props} />
          }
          if (orientation === 'right') {
            return <ChevronRightIcon className={cn('size-4', className)} {...props} />
          }
          // 下拉标题标签中使用的向下箭头
          return <ChevronDownIcon className={cn('size-3.5', className)} {...props} />
        },
        DayButton: CalendarDayButton,
      }}
      {...props}
    />
  )
}

/**
 * 日历单日单元格按钮。
 * 使用弹性尺寸填满父单元格，并处理选中/聚焦状态。
 */
function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)

  // 当 react-day-picker 标记该日为 focused（键盘导航）时让按钮获得焦点
  React.useEffect(() => {
    if (modifiers.focused) {
      ref.current?.focus()
    }
  }, [modifiers.focused])

  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-md text-sm',
        // 填满单元格：宽度自适应，最小高度/宽度由 CSS 变量决定
        'h-[--cell-size] w-full min-w-[--cell-size] select-none',
        'hover:bg-foreground/5 transition-colors cursor-pointer',
        // 根据 modifiers 处理选中态
        modifiers.selected && 'bg-background shadow-minimal font-medium',
        'outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      {...props}
    />
  )
}

export { Calendar }
