/**
 * LabelBadgeRow — 输入框上方的 Label 徽章行
 *
 * 在 FreeFormInput 的 RichTextInput 上方展示一组 Label 徽章。
 * 每个徽章显示 Label 颜色、名称和可选的类型值；点击后弹出 LabelValuePopover
 * 用于编辑或移除。
 *
 * 数据流：
 * - sessionLabels: string[]，编码后的标签条目，如 ["bug", "priority::3", "due::2026-01-30"]
 * - labels: LabelConfig[]，workspace 的 Label 树，用于解析颜色/值类型
 * - 先用 parseLabelEntry 解出 id + rawValue
 * - 再从拍平的 Label 树中找到对应 LabelConfig
 */

import * as React from 'react'
import { LabelValuePopover } from './label-value-popover'
import { LabelIcon, LabelValueTypeIcon } from './label-icon'
import { MetadataBadge } from './metadata-badge'
import { parseLabelEntry, formatLabelEntry, formatDisplayValue } from '@craft-agent/shared/labels'
import { openLabelLink } from '@/lib/open-label-link'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import { useTheme } from '@/context/ThemeContext'
import { cn } from '@/lib/utils'

export interface LabelBadgeRowProps {
  /** 已应用的 Session labels（编码字符串，如 "bug" 或 "priority::3"） */
  sessionLabels: string[]
  /** 完整 Label 配置树（用于解析颜色、名称、值类型） */
  labels: LabelConfig[]
  /** Label 值变化回调，接收更新后的完整 sessionLabels 数组 */
  onLabelsChange?: (updatedLabels: string[]) => void
  /** 容器额外 className */
  className?: string
}

/**
 * 把递归的 LabelConfig 树拍平成 id → LabelConfig 的 Map，
 * 解析 session label 时可 O(1) 查找。
 */
function flattenLabelTree(labels: LabelConfig[]): Map<string, LabelConfig> {
  const map = new Map<string, LabelConfig>()
  function walk(items: LabelConfig[]) {
    for (const item of items) {
      map.set(item.id, item)
      if (item.children?.length) {
        walk(item.children)
      }
    }
  }
  walk(labels)
  return map
}

/** Label 徽章行 */
export function LabelBadgeRow({
  sessionLabels,
  labels,
  onLabelsChange,
  className,
}: LabelBadgeRowProps) {
  const { isDark } = useTheme()

  // 记录当前打开 popover 的 badge 索引
  const [openIndex, setOpenIndex] = React.useState<number | null>(null)

  // 缓存拍平后的查找表，只在 labels 配置变化时重新计算
  const labelMap = React.useMemo(() => flattenLabelTree(labels), [labels])

  // 没有标签时不渲染
  if (sessionLabels.length === 0) return null

  /** 更新某个 label 条目的值 */
  const handleValueChange = (index: number, labelId: string, newValue: string | undefined) => {
    const updated = [...sessionLabels]
    updated[index] = formatLabelEntry(labelId, newValue)
    onLabelsChange?.(updated)
  }

  /** 移除某个索引的 label */
  const handleRemove = (index: number) => {
    const updated = sessionLabels.filter((_, i) => i !== index)
    onLabelsChange?.(updated)
  }

  return (
    <div className={cn('flex flex-wrap gap-1 px-4 pt-3 pb-1', className)}>
      {sessionLabels.map((entry, index) => {
        const parsed = parseLabelEntry(entry)
        const config = labelMap.get(parsed.id)

        // 找不到配置时，用最小 fallback 让徽章仍能渲染
        const resolvedConfig: LabelConfig = config ?? { id: parsed.id, name: parsed.id }
        const displayValue = parsed.rawValue ? formatDisplayValue(parsed.rawValue, resolvedConfig.valueType) : undefined
        const resolvedColor = resolvedConfig.color
          ? resolveEntityColor(resolvedConfig.color, isDark)
          : 'var(--foreground)'

        return (
          <LabelValuePopover
            key={`${parsed.id}-${index}`}
            label={resolvedConfig}
            value={parsed.rawValue}
            open={openIndex === index}
            onOpenChange={(open) => setOpenIndex(open ? index : null)}
            onValueChange={(newValue) => handleValueChange(index, parsed.id, newValue)}
            onRemove={() => handleRemove(index)}
          >
            <MetadataBadge
              label={resolvedConfig.name}
              value={displayValue}
              onValueClick={resolvedConfig.valueType === 'link' && parsed.rawValue ? () => openLabelLink(parsed.rawValue!) : undefined}
              icon={<LabelIcon label={resolvedConfig} size="lg" />}
              valueHintIcon={resolvedConfig.valueType ? <LabelValueTypeIcon valueType={resolvedConfig.valueType} /> : undefined}
              badgeColor={resolvedColor}
              interactive
              isActive={openIndex === index}
              showChevron
            />
          </LabelValuePopover>
        )
      })}
    </div>
  )
}
