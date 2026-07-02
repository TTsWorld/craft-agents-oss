/**
 * Info_Alert
 *
 * 信息页中的警告 / 错误 / 信息 / 成功提示框，采用复合组件写法（Title + Description）。
 * 类似 Go 中一个 struct 带多个方法，这里用 Object.assign 把子组件挂到根组件上。
 */

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/** 使用 class-variance-authority 定义 alert 的样式变体（variant / inline） */
const alertVariants = cva('rounded-[8px] border', {
  variants: {
    variant: {
      warning: 'bg-foreground/5 border-border/50',
      error: 'bg-destructive/5 border-destructive/30',
      info: 'bg-info/5 border-info/30',
      success: 'bg-success/5 border-success/30',
    },
    inline: {
      true: 'px-4 py-2',
      false: 'px-4 py-3',
    },
  },
  defaultVariants: {
    variant: 'warning',
    inline: false,
  },
})

export interface Info_AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  /** 可选的前置图标 */
  icon?: React.ReactNode
}

function Info_AlertRoot({
  variant,
  inline,
  icon,
  className,
  children,
  ...props
}: Info_AlertProps) {
  return (
    <div className={cn(alertVariants({ variant, inline }), className)} {...props}>
      <div className="flex items-start gap-2 text-sm">
        {icon && (
          <span className="shrink-0 mt-0.5 text-muted-foreground">{icon}</span>
        )}
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  )
}

function Info_AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('font-medium', className)} {...props} />
}

function Info_AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-foreground/60 mt-0.5', className)} {...props} />
}

export const Info_Alert = Object.assign(Info_AlertRoot, {
  Title: Info_AlertTitle,
  Description: Info_AlertDescription,
})
