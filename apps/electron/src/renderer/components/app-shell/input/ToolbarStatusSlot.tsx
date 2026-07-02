/**
 * ToolbarStatusSlot - 输入工具栏底部行的优先级覆盖层。
 *
 * 用于显示上下文状态提示：
 * - 最高优先级：按 Esc 中断 agent 的提示
 * - 次优先级：浏览器会话状态
 * - 未来可扩展其他状态类型
 *
 * 通过绝对定位覆盖在工具栏容器上，用 AnimatePresence 做状态切换淡入淡出。
 * 浏览器状态直接从 Jotai atom 读取（和 BrowserTabStrip 同一套模式），避免把 props 穿透多层组件。
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Globe } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { useTranslation, Trans } from 'react-i18next'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { getHostname, getThemeLuminance } from '@/components/browser/utils'
import { browserInstancesAtom, filterInstancesForWorkspace } from '@/atoms/browser-pane'
import { useAppShellContext } from '@/context/AppShellContext'
import type { BrowserInstanceInfo } from '../../../../shared/types'

interface ToolbarStatusSlotProps {
  /** 是否显示“按 Esc 中断”覆盖层（最高优先级） */
  showEscapeOverlay: boolean
  /** 用于查找绑定到当前会话的浏览器实例 */
  sessionId?: string
}

/** ToolbarStatusSlot - 工具栏状态覆盖层 */
export function ToolbarStatusSlot({
  showEscapeOverlay,
  sessionId,
}: ToolbarStatusSlotProps) {
  // 只过滤当前工作区的浏览器实例，避免当前会话显示其它工作区 agent 的状态。
  // 同时接受本地工作区 ID（手动标签页）和远程镜像工作区 ID（远程 agent 通过 WS 桥盖戳的标签页）。
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId ?? null
  const allInstances = useAtomValue(browserInstancesAtom)
  const browserInstances = React.useMemo(
    () => filterInstancesForWorkspace(allInstances, activeWorkspaceId, remoteWorkspaceId),
    [allInstances, activeWorkspaceId, remoteWorkspaceId],
  )

  // 查找绑定到当前会话、且 agent 正在控制的可见浏览器实例。
  // 隐藏实例被故意排除，保证状态槽只反映实际可见的浏览器。
  const browserInstance = React.useMemo(() => {
    if (!sessionId) return null

    const visibleCandidates = browserInstances.filter(
      i => i.boundSessionId === sessionId && i.agentControlActive && i.isVisible
    )
    if (visibleCandidates.length === 0) return null

    return visibleCandidates.at(-1) ?? null
  }, [browserInstances, sessionId])

  // 优先级判定：Esc 中断提示 > 浏览器状态
  const showBrowser = !showEscapeOverlay && browserInstance !== null

  const handleBrowserClick = React.useCallback((instanceId: string) => {
    window.electronAPI?.browserPane?.focus?.(instanceId)
  }, [])

  return (
    <AnimatePresence>
      {showEscapeOverlay && (
        <motion.div
          key="escape"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={cn(
            "absolute inset-0 z-10",
            "rounded-b-[12px]",
            "shadow-tinted",
            "flex items-center justify-center",
            "pointer-events-auto",
          )}
          style={{
            '--shadow-color': 'var(--info-rgb)',
            backgroundColor: 'color-mix(in srgb, var(--info) 10%, var(--background))',
            color: 'color-mix(in oklab, var(--info) 30%, var(--foreground))',
          } as React.CSSProperties}
        >
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Trans
              i18nKey="toolbar.escapeToInterrupt"
              components={{ kbd: <Kbd className="text-inherit bg-current/10" /> }}
            />
          </span>
        </motion.div>
      )}

      {showBrowser && browserInstance && (
        <BrowserStatusBar
          key="browser"
          instance={browserInstance}
          onClick={() => handleBrowserClick(browserInstance.id)}
        />
      )}
    </AnimatePresence>
  )
}

/**
 * BrowserStatusBar - agent 正在使用浏览器窗口时显示的状态条。
 * 使用网站的主题色作为背景，并根据亮度计算文字对比色。
 */
function BrowserStatusBar({
  instance,
  onClick,
}: {
  instance: BrowserInstanceInfo
  onClick: () => void
}) {
  const { t } = useTranslation()
  const hostname = getHostname(instance.url)
  const themeColor = instance.themeColor
  const themeLuminance = themeColor ? getThemeLuminance(themeColor) : null
  const isDarkTheme = themeLuminance !== null && themeLuminance < 0.42

  // 根据是否有主题色计算背景样式
  const backgroundStyle = themeColor
    ? { backgroundColor: themeColor }
    : { backgroundColor: 'color-mix(in srgb, var(--accent) 15%, var(--background))' }

  const textColorClass = themeColor
    ? (isDarkTheme ? 'text-white/90' : 'text-black/80')
    : ''

  const [faviconFailed, setFaviconFailed] = React.useState(false)

  React.useEffect(() => {
    setFaviconFailed(false)
  }, [instance.favicon])

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "absolute inset-0 z-10",
        "rounded-b-[12px]",
        "flex items-center justify-center gap-2",
        "pointer-events-auto cursor-pointer",
        "transition-[background-color] duration-200",
        textColorClass,
      )}
      style={{
        ...backgroundStyle,
      } as React.CSSProperties}
      onClick={onClick}
    >
      {/* 横幅顶部的高亮渐变 loading 线 */}
      <div className="absolute top-0 left-0 right-0 h-[2px] z-10 overflow-hidden">
        <div
          className="h-full w-full animate-shimmer-loading"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%)',
          }}
        />
      </div>

      <span className={`shrink-0 flex items-center justify-center ${isDarkTheme ? 'h-4 w-4' : 'h-3.5 w-3.5'}`}>
        {instance.isLoading ? (
          <Spinner className="text-[10px] leading-none" />
        ) : instance.favicon && !faviconFailed ? (
          isDarkTheme ? (
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-[5px] bg-white/90 p-[1px] leading-none">
              <img
                src={instance.favicon}
                alt=""
                className="h-3.5 w-3.5 aspect-square rounded-none object-cover block"
                onError={() => setFaviconFailed(true)}
              />
            </span>
          ) : (
            <img
              src={instance.favicon}
              alt=""
              className="h-3.5 w-3.5 rounded-sm block"
              onError={() => setFaviconFailed(true)}
            />
          )
        ) : (
          <Globe className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="text-sm font-medium truncate max-w-[200px]">
        {t('chat.usingConnection', { name: hostname })}
      </span>
    </motion.button>
  )
}
