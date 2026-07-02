/**
 * Source（数据来源）选择弹窗
 *
 * Source 是 Agent 可以调用的外部能力，比如 MCP 服务器、API、本地文件夹等。
 * 这个组件封装了一个可过滤的多选弹窗，用于在聊天输入前选择要启用的 Source。
 */
import * as React from 'react'
import { Check, DatabaseZap } from 'lucide-react'
import { FilterableSelectPopover } from '@craft-agent/ui'

import { cn } from '@/lib/utils'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSource } from '../../../shared/types'

export interface SourceSelectorPopoverProps {
  /** 弹窗是否打开 */
  open: boolean
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void
  /** 锚点按钮 ref，弹窗会相对它定位 */
  anchorRef: React.RefObject<HTMLButtonElement | null>
  /** 可选的 Source 列表 */
  sources: LoadedSource[]
  /** 已选中的 Source slug 数组 */
  selectedSlugs: string[]
  /** 切换某个 Source 选中状态的回调 */
  onToggleSlug: (slug: string) => void
}

/** Source 选择弹窗组件 */
export function SourceSelectorPopover({
  open,
  onOpenChange,
  anchorRef,
  sources,
  selectedSlugs,
  onToggleSlug,
}: SourceSelectorPopoverProps) {
  return (
    <FilterableSelectPopover
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      items={sources}
      getKey={(source) => source.config.slug}
      getLabel={(source) => source.config.name}
      isSelected={(source) => selectedSlugs.includes(source.config.slug)}
      onToggle={(source) => onToggleSlug(source.config.slug)}
      filterPlaceholder="Search sources..."
      emptyState={(
        <>
          No sources configured.
          <br />
          Add sources in Settings.
        </>
      )}
      noResultsState="No matching sources."
      minWidth={200}
      maxWidth={320}
      renderItem={(source, state, index) => (
        <div
          data-tutorial={index === 0 ? 'source-dropdown-item-first' : undefined}
          className={cn(
            'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]',
            state.highlighted && 'bg-foreground/5',
            state.selected && 'bg-foreground/3',
          )}
        >
          <div className="shrink-0 text-muted-foreground flex items-center">
            {source.config.slug
              ? <SourceAvatar source={source} size="sm" />
              : <DatabaseZap className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0 truncate">{source.config.name}</div>
          <div
            className={cn(
              'shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center',
              !state.selected && 'opacity-0',
            )}
          >
            <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
          </div>
        </div>
      )}
    />
  )
}
