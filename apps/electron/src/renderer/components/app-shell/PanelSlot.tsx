/**
 * PanelSlot - 在 PanelStackContainer 内渲染单个内容面板。
 *
 * - 当只有一个面板时（isOnly），flex-grow 占满可用空间。
 * - 多个面板时，按 proportion 分配权重，并用 min-width 限制不小于 PANEL_MIN_WIDTH。
 *
 * 每个 PanelSlot 会覆盖 AppShellContext，把当前面板的关闭按钮注入到 PanelHeader 的 rightSidebarButton 插槽。
 * 所有面板平等，关闭任意一个都会从栈中移除；栈为空时会触发窗口关闭。
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { X, ChevronLeft } from 'lucide-react'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import { closePanelAtom, focusedPanelIdAtom, type PanelStackEntry } from '@/atoms/panel-stack'
import { useAppShellContext, AppShellProvider } from '@/context/AppShellContext'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { MainContentPanel } from './MainContentPanel'
import { PANEL_MIN_WIDTH, RADIUS_EDGE, RADIUS_INNER } from './panel-constants'

interface PanelSlotProps {
  entry: PanelStackEntry
  isOnly: boolean
  /** 当前面板是否为多面板布局中的焦点面板 */
  isFocusedPanel: boolean
  isSidebarAndNavigatorHidden: boolean
  /** 当前面板左侧是否贴到窗口边缘（前面没有侧边栏/导航器） */
  isAtLeftEdge: boolean
  /** 当前面板右侧是否贴到窗口边缘（后面没有右侧边栏） */
  isAtRightEdge: boolean
  /** flex-grow 权重，用于按比例分配空间 */
  proportion: number
  /** 渲染在当前面板之前的可选 sash（拖拽分隔条） */
  sash?: React.ReactNode
  /** 紧凑/移动端模式：在标题栏显示返回按钮 */
  isCompact?: boolean
}

/** PanelSlot - 单个内容面板槽位 */
export function PanelSlot({
  entry,
  isOnly,
  isFocusedPanel,
  isSidebarAndNavigatorHidden,
  isAtLeftEdge,
  isAtRightEdge,
  proportion,
  sash,
  isCompact,
}: PanelSlotProps) {
  const { t } = useTranslation()
  const closePanel = useSetAtom(closePanelAtom)
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const parentContext = useAppShellContext()
  const navState = parseRouteToNavigationState(entry.route)

  const handleClose = useCallback(() => {
    closePanel(entry.id)
  }, [closePanel, entry.id])

  // 构造关闭按钮，通过 context 覆盖注入到 PanelHeader 的右侧插槽
  const closeButton = useMemo(() => {
    return (
      <PanelHeaderCenterButton
        icon={<X className="h-4 w-4" />}
        onClick={handleClose}
        tooltip={t("common.close")}
      />
    )
  }, [handleClose])

  // 紧凑模式下的返回按钮：点击后关闭面板，回到会话列表。
  // 和关闭按钮使用同样的 PanelHeaderCenterButton 样式，只是放在左侧。
  const backButton = useMemo(() => {
    if (!isCompact) return undefined
    return (
      <PanelHeaderCenterButton
        icon={<ChevronLeft className="h-4 w-4" />}
        onClick={handleClose}
        tooltip={t("common.backToList")}
      />
    )
  }, [isCompact, handleClose])

  // 覆盖 AppShellContext，让 ChatPage/PanelHeader 拿到当前面板的关闭按钮、
  // 返回按钮（紧凑模式）以及 isFocusedPanel 状态
  const contextOverride = useMemo(() => ({
    ...parentContext,
    rightSidebarButton: closeButton,
    leadingAction: backButton,
    isFocusedPanel,
  }), [parentContext, closeButton, backButton, isFocusedPanel])

  const handlePointerDown = useCallback(() => {
    if (!isFocusedPanel) {
      setFocusedPanel(entry.id)
    }
  }, [isFocusedPanel, setFocusedPanel, entry.id])

  return (
    <>
      {sash}
      <div
        onPointerDown={handlePointerDown}
        data-panel-role="content"
        data-compact={isCompact || undefined}
        className={cn(
          'h-full overflow-hidden relative @container/panel',
          !isOnly && isFocusedPanel ? 'shadow-panel-focused z-[1]' : 'shadow-middle z-0',
          'bg-foreground-2',
        )}
        style={{
          // 多面板中，非焦点面板覆盖 --background，让所有 bg-background 子元素渲染成暗色背景。
          ...(!isFocusedPanel && !isOnly
            ? {
                '--background': 'var(--background-elevated)',
                '--shadow-minimal': 'var(--shadow-minimal-flat)',
                '--user-message-bubble': 'var(--user-message-bubble-dimmed)',
              } as React.CSSProperties
            : {}
          ),
          // 圆角：贴窗口边缘的角用 RADIUS_EDGE，内部相邻的角用 RADIUS_INNER。
          // 紧凑模式下面板贴底，底部不要圆角。
          borderTopLeftRadius: RADIUS_INNER,
          borderBottomLeftRadius: isCompact ? 0 : (isAtLeftEdge ? RADIUS_EDGE : RADIUS_INNER),
          borderTopRightRadius: RADIUS_INNER,
          borderBottomRightRadius: isCompact ? 0 : (isAtRightEdge ? RADIUS_EDGE : RADIUS_INNER),
          ...(isOnly
            ? { flexGrow: 1, minWidth: 0 }
            : { flexGrow: proportion, flexShrink: 1, flexBasis: 0, minWidth: PANEL_MIN_WIDTH }
          ),
        }}
      >
        <div className="h-full flex flex-col">
          <AppShellProvider value={contextOverride}>
            <MainContentPanel
              navStateOverride={navState}
              isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
            />
          </AppShellProvider>
        </div>
      </div>
    </>
  )
}
