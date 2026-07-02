/**
 * SourceStatusIndicator — Source 连接状态指示器
 *
 * Source 是 Agent 可调用的外部能力（MCP 服务器、API、本地文件夹等）。
 * 这个组件用一个小圆点表示 Source 的连接状态：
 * - 绿色：已连接/测试成功
 * - 蓝色：需要认证
 * - 红色：连接失败
 * - 灰色：未测试
 *
 * 悬停时显示状态描述的 Tooltip。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@craft-agent/ui'
import type { SourceConnectionStatus } from '../../../shared/types'

export interface SourceStatusIndicatorProps {
  /** 连接状态 */
  status?: SourceConnectionStatus
  /** 错误信息（status 为 failed 时显示在 tooltip 中） */
  errorMessage?: string
  /** 尺寸变体 */
  size?: 'xs' | 'sm' | 'md'
  /** 额外 className */
  className?: string
}

// 状态配置
const STATUS_CONFIG: Record<SourceConnectionStatus, {
  color: string
  pulseColor: string
  label: string
  description: string
}> = {
  connected: {
    color: 'bg-success',
    pulseColor: 'bg-success/80',
    label: 'Connected',
    description: 'Source is connected and working',
  },
  needs_auth: {
    color: 'bg-info',
    pulseColor: 'bg-info/80',
    label: 'Needs Authentication',
    description: 'Source requires authentication to connect',
  },
  failed: {
    color: 'bg-destructive',
    pulseColor: 'bg-destructive/80',
    label: 'Connection Failed',
    description: 'Failed to connect to source',
  },
  untested: {
    color: 'bg-foreground/40',
    pulseColor: 'bg-foreground/30',
    label: 'Not Tested',
    description: 'Connection has not been tested',
  },
  local_disabled: {
    color: 'bg-foreground/30',
    pulseColor: 'bg-foreground/20',
    label: 'Disabled',
    description: 'Local MCP servers are disabled in Settings',
  },
}

// 尺寸配置
const SIZE_CONFIG: Record<'xs' | 'sm' | 'md', string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
}

/** Source 连接状态指示器 */
export function SourceStatusIndicator({
  status = 'untested',
  errorMessage,
  size = 'sm',
  className,
}: SourceStatusIndicatorProps) {
  const config = STATUS_CONFIG[status]
  const sizeClass = SIZE_CONFIG[size]

  // 组合 tooltip 描述
  const tooltipDescription = status === 'failed' && errorMessage
    ? `${config.description}: ${errorMessage}`
    : config.description

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'relative inline-flex shrink-0',
            className
          )}
        >
          {/* connected 状态显示脉冲动画 */}
          {status === 'connected' && (
            <span
              className={cn(
                'absolute inline-flex rounded-full opacity-75 animate-ping',
                config.pulseColor,
                sizeClass
              )}
              style={{ animationDuration: '2s' }}
            />
          )}
          {/* 状态圆点 */}
          <span
            className={cn(
              'relative inline-flex rounded-full',
              config.color,
              sizeClass
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{config.label}</span>
          <span className="text-foreground/60">{tooltipDescription}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * 从 Source 配置推导连接状态
 * 这是一个便捷函数，根据已有字段判断状态。
 *
 * @param source - Source 配置
 * @param localMcpEnabled - 本地 MCP 服务器是否启用（默认 true）
 */
export function deriveConnectionStatus(source: {
  config: {
    isAuthenticated?: boolean
    connectionStatus?: SourceConnectionStatus
    type?: string
    mcp?: { authType?: string; transport?: string }
    api?: { authType?: string }
  }
}, localMcpEnabled = true): SourceConnectionStatus {
  // stdio 类型的本地 MCP 被禁用时返回 local_disabled
  const mcp = source.config.mcp
  if (mcp?.transport === 'stdio' && !localMcpEnabled) {
    return 'local_disabled'
  }

  // 如果配置显式设置了 connectionStatus，直接使用
  if (source.config.connectionStatus) {
    return source.config.connectionStatus
  }

  // 从认证状态推导
  const api = source.config.api
  const authType = mcp?.authType ?? api?.authType
  const isAuthenticated = authType === 'none' || authType === undefined
    ? true
    : source.config['isAuthenticated'] === true

  if (!isAuthenticated) {
    return 'needs_auth'
  }

  if (isAuthenticated) {
    return 'connected'
  }

  // 本地 source 默认可用
  if (source.config.type === 'local') {
    return 'connected'
  }

  return 'untested'
}
