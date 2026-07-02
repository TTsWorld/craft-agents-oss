/**
 * ConnectionIcon —— 为某个 LLM 连接显示对应服务商的图标。
 *
 * 如果找不到服务商图标，会回退到一个带“大脑”图标的占位方块。
 * 在以下场景使用：
 * - AI 设置（连接列表）
 * - FreeFormInput（模型展示）
 * - Session List（连接徽标）
 * - New Session（模型选择器分组名）
 *
 * 对 Go 同学的小提示：
 * - `Pick<...>` 是 TypeScript 的工具类型，表示“从大类型里挑几个字段”，类似 Go 里从大 struct 取子集。
 * - `& { type?: string }` 是交叉类型，给原类型再追加可选字段，相当于在原有字段基础上“扩展”。
 */

import { Brain } from 'lucide-react'
import { getProviderIcon } from '@/lib/provider-icons'
import { getModelDisplayName } from '@config/models'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import type { LlmConnectionWithStatus } from '../../../shared/types'

interface ConnectionIconProps {
  /** 要展示图标的 LLM 连接 */
  connection: Pick<LlmConnectionWithStatus, 'name' | 'providerType' | 'baseUrl' | 'piAuthProvider'> & { type?: string; defaultModel?: string }
  /** 图标尺寸，单位 px（默认 16） */
  size?: number
  /** 额外的 CSS 类名 */
  className?: string
  /** 悬停时是否显示包含连接名和模型的提示框（默认 false） */
  showTooltip?: boolean
}

export function ConnectionIcon({ connection, size = 16, className = '', showTooltip = false }: ConnectionIconProps) {
  // 根据 providerType / type / baseUrl / piAuthProvider 解析出对应服务商图标 URL
  const providerIcon = getProviderIcon(
    connection.providerType || connection.type || '',
    connection.baseUrl,
    connection.piAuthProvider
  )

  // 如果有服务商图标就用 <img> 展示；否则用默认的大脑占位图标
  const iconElement = providerIcon ? (
    <img
      src={providerIcon}
      alt=""
      width={size}
      height={size}
      className={`rounded-[3px] flex-shrink-0 ${className}`}
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      className={`rounded-[3px] bg-foreground/10 flex items-center justify-center flex-shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <Brain
        className="text-foreground/50 flex-shrink-0"
        style={{ width: Math.round(size * 0.7), height: Math.round(size * 0.7) }}
      />
    </div>
  )

  // 不需要提示框时直接返回图标元素
  if (!showTooltip) return iconElement

  // 需要提示框时，用 Tooltip 组件包裹图标，显示连接名和默认模型
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {iconElement}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        <div className="text-center">
          <div>{connection.name}</div>
          {connection.defaultModel && <div className="text-[10px] opacity-60">{getModelDisplayName(connection.defaultModel)}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
