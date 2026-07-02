/**
 * CompactSourceSelector — 紧凑/触摸模式下的 Source 选择抽屉。
 *
 * Source 是 Agent 可调用的外部能力（MCP 服务器、API、本地文件夹等）。
 * 这个组件与桌面端 SourceSelectorPopover 语义一致（多选、可切换），
 * 但改用 Drawer（底部抽屉）渲染，不依赖锚点定位，并且每行都是 44px 以上的触控区。
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, DatabaseZap, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SourceAvatar } from '@/components/ui/source-avatar'
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import type { LoadedSource } from '../../../shared/types'

/** CompactSourceSelector 的 props。 */
export interface CompactSourceSelectorProps {
  /** 抽屉是否打开 */
  open: boolean
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void
  /** 可选的 Source 列表 */
  sources: LoadedSource[]
  /** 已选中的 Source slug 数组 */
  selectedSlugs: string[]
  /** 切换某个 Source 选中状态的回调 */
  onToggleSlug: (slug: string) => void
}

/** 紧凑模式 Source 选择器 */
export function CompactSourceSelector({
  open,
  onOpenChange,
  sources,
  selectedSlugs,
  onToggleSlug,
}: CompactSourceSelectorProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = React.useState('')

  // 抽屉关闭时重置过滤词，下次打开保持干净状态。
  React.useEffect(() => {
    if (!open) setFilter('')
  }, [open])

  const filteredSources = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sources
    return sources.filter((source) => source.config.name.toLowerCase().includes(q))
  }, [sources, filter])

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('chat.sourcesTooltip')}</DrawerTitle>
        </DrawerHeader>

        {sources.length > 0 && (
          <div className="px-4 pb-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground/40 pointer-events-none" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('common.search')}
                className="w-full h-11 pl-10 pr-3 rounded-[10px] bg-foreground/5 text-base outline-none focus:bg-foreground/[0.07] transition-colors"
              />
            </div>
          </div>
        )}

        <div className="px-2 pb-4 flex flex-col gap-0.5 max-h-[55vh] overflow-y-auto">
          {sources.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground/50">
              {t('sourcesList.noSourcesConfigured')}
            </div>
          ) : filteredSources.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground/50">
              {t('chat.noResults')}
            </div>
          ) : (
            filteredSources.map((source) => {
              const isSelected = selectedSlugs.includes(source.config.slug)
              return (
                <button
                  key={source.config.slug}
                  type="button"
                  onClick={() => onToggleSlug(source.config.slug)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-3 rounded-[10px] text-left transition-colors',
                    isSelected ? 'bg-foreground/5' : 'hover:bg-foreground/5',
                  )}
                >
                  <div className="shrink-0 flex items-center">
                    {source.config.slug
                      ? <SourceAvatar source={source} size="md" />
                      : <DatabaseZap className="h-5 w-5 text-foreground/60" />}
                  </div>
                  <div className="flex-1 min-w-0 text-sm font-medium truncate">
                    {source.config.name}
                  </div>
                  <div
                    className={cn(
                      'shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors',
                      isSelected
                        ? 'border-foreground bg-foreground'
                        : 'border-foreground/20',
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3 text-background" strokeWidth={3} />}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
