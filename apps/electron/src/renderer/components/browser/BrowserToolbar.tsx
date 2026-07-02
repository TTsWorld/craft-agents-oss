/**
 * BrowserToolbar
 *
 * 围绕共享组件 BrowserControls 的 Electron 端薄包装。
 * 它从 BrowserInstanceInfo 推导出地址栏、前进/后退、加载/停止等控制状态。
 */

import { BrowserControls } from '@craft-agent/ui'
import type { BrowserInstanceInfo } from '../../../shared/types'

// BrowserToolbar 的 props：instanceInfo 为 null 时按“无可用浏览器”显示禁用状态。
interface BrowserToolbarProps {
  instanceInfo: BrowserInstanceInfo | null
  onNavigate: (url: string) => void
  onGoBack: () => void
  onGoForward: () => void
  onReload: () => void
  onStop: () => void
  compact?: boolean
}

// 这是一个“纯展示包装”组件：把实例状态映射成 BrowserControls 需要的 props，不处理副作用。
export function BrowserToolbar({
  instanceInfo,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onStop,
  compact = false,
}: BrowserToolbarProps) {
  return (
    <BrowserControls
      url={instanceInfo?.url ?? ''}
      loading={instanceInfo?.isLoading ?? false}
      canGoBack={instanceInfo?.canGoBack ?? false}
      canGoForward={instanceInfo?.canGoForward ?? false}
      onNavigate={onNavigate}
      onGoBack={onGoBack}
      onGoForward={onGoForward}
      onReload={onReload}
      onStop={onStop}
      compact={compact}
      showProgressBar={!compact}
      className={
        compact
          ? 'h-auto px-1.5 py-0.5 rounded-[8px] border border-foreground/10 bg-background/70 min-w-0'
          : 'h-auto px-2 py-1.5 border-b border-border bg-background/80'
      }
    />
  )
}
