/**
 * SettingsSection, SettingsGroup, SettingsDivider
 *
 * 设置页的结构组件，用于组织页面层级：
 * SettingsGroup > SettingsSection > SettingsCard/SettingsRadioGroup。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

// ============================================
// SettingsSection
// ============================================

export interface SettingsSectionProps {
  /** 区块标题 */
  title: string
  /** 标题下方的描述（支持 ReactNode，可放内联链接） */
  description?: React.ReactNode
  /** 内容，通常是 SettingsCard 或 SettingsRadioGroup */
  children: React.ReactNode
  /** 额外 className */
  className?: string
  /** 视觉变体 */
  variant?: 'default' | 'danger'
  /** 标题右侧的操作元素（例如 Edit 按钮） */
  action?: React.ReactNode
}

/**
 * SettingsSection - 带标题和描述的语义化区块
 *
 * @example
 * <SettingsSection title="Billing" description="Choose how you pay">
 *   <SettingsRadioGroup>...</SettingsRadioGroup>
 * </SettingsSection>
 */
export function SettingsSection({
  title,
  description,
  children,
  className,
  variant = 'default',
  action,
}: SettingsSectionProps) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex items-start justify-between gap-4 pl-1">
        <div className="space-y-0.5">
          <h3
            className={cn(
              'text-base font-semibold',
              variant === 'danger' && 'text-destructive'
            )}
          >
            {title}
          </h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}

// ============================================
// SettingsGroup
// ============================================

export interface SettingsGroupProps {
  /** 分组标题（会显示为大写） */
  title: string
  /** 内容，通常是多个 SettingsSection */
  children: React.ReactNode
  /** 额外 className */
  className?: string
}

/**
 * SettingsGroup - 顶层分组，用于区分大模块（如 App / Workspace）
 *
 * @example
 * <SettingsGroup title="Workspace">
 *   <SettingsSection title="Model">...</SettingsSection>
 *   <SettingsSection title="Permissions">...</SettingsSection>
 * </SettingsGroup>
 */
export function SettingsGroup({ title, children, className }: SettingsGroupProps) {
  return (
    <div className={cn('space-y-6', className)}>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pb-2 border-b border-border">
        {title}
      </h2>
      <div className="space-y-8">{children}</div>
    </div>
  )
}

// ============================================
// SettingsDivider
// ============================================

export interface SettingsDividerProps {
  /** 额外 className */
  className?: string
}

/**
 * SettingsDivider - 区块之间的水平分隔线
 *
 * 不建议频繁使用，通常垂直间距已经足够。
 */
export function SettingsDivider({ className }: SettingsDividerProps) {
  return <div className={cn('h-px bg-border', className)} />
}
