/**
 * DiffViewerControls - diff 查看器的头部控件
 *
 * 展示：
 * - 变更统计（-X +Y，带颜色文本）
 * - diff 样式切换（unified/split）
 * - 背景切换（启用/禁用高亮）
 *
 * 样式匹配 diffs.com 控件
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { DiffSplitIcon, DiffUnifiedIcon, DiffBackgroundIcon } from './DiffIcons'

export interface DiffViewerControlsProps {
  /** 新增行数 */
  additions: number
  /** 删除行数 */
  deletions: number

  /** 当前 diff 样式 */
  diffStyle: 'unified' | 'split'
  /** diff 样式变化时的回调 */
  onDiffStyleChange: (style: 'unified' | 'split') => void

  /** 是否禁用背景高亮 */
  disableBackground: boolean
  /** 背景切换变化时的回调 */
  onBackgroundChange: (disabled: boolean) => void

  /** 额外 className */
  className?: string
}

/**
 * DiffViewerControls - diff 查看器设置的紧凑控件栏
 *
 * 按钮样式匹配 diffs.com：opacity-60 hover:opacity-100
 */
export function DiffViewerControls({
  additions,
  deletions,
  diffStyle,
  onDiffStyleChange,
  disableBackground,
  onBackgroundChange,
  className,
}: DiffViewerControlsProps) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {/* 统计展示：-X +Y */}
      <div className="flex items-center gap-2 mr-0.5 text-[13px] font-medium font-mono">
        <span className="text-destructive">-{deletions}</span>
        <span className="text-success">+{additions}</span>
      </div>

      {/* diff 样式切换——展示另一种模式的图标（即将要切换到的模式） */}
      <button
        type="button"
        onClick={() => onDiffStyleChange(diffStyle === 'unified' ? 'split' : 'unified')}
        className="cursor-pointer p-1.5 rounded-[6px] bg-background shadow-minimal opacity-70 hover:opacity-100 transition-opacity"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={diffStyle === 'unified' ? t('diff.switchToSplit') : t('diff.switchToUnified')}
        aria-label={diffStyle === 'unified' ? t('diff.switchToSplit') : t('diff.switchToUnified')}
      >
        {/* unified 模式下展示 split 图标（以便切换到 split），反之亦然 */}
        {diffStyle === 'unified' ? <DiffSplitIcon /> : <DiffUnifiedIcon />}
      </button>

      {/* 背景切换 */}
      <button
        type="button"
        onClick={() => onBackgroundChange(!disableBackground)}
        className={cn(
          'cursor-pointer p-1.5 rounded-[6px] bg-background shadow-minimal transition-opacity',
          disableBackground ? 'opacity-40 hover:opacity-70' : 'opacity-70 hover:opacity-100'
        )}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={disableBackground ? t('diff.enableBackground') : t('diff.disableBackground')}
        aria-label={disableBackground ? t('diff.enableBackground') : t('diff.disableBackground')}
      >
        <DiffBackgroundIcon />
      </button>
    </div>
  )
}
