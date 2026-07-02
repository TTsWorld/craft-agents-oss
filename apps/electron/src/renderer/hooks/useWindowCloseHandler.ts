import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useModalRegistry } from '@/context/ModalContext'
import { useDismissibleLayerRegistry } from '@/context/DismissibleLayerContext'
import { panelStackAtom, closePanelAtom, focusedPanelIdAtom } from '@/atoms/panel-stack'
import type { WindowCloseRequest } from '../../shared/types'

/**
 * 处理窗口关闭请求的 hook，根据关闭来源采取不同行为。
 *
 * - `window-button`：直接关闭窗口。
 * - `keyboard-shortcut`（Cmd/Ctrl+W）：分层关闭：
 *   1. 关闭最顶层 modal
 *   2. 否则关闭当前聚焦 panel
 *   3. 否则关闭窗口
 * - `unknown`：同样按分层关闭作为安全回退。
 *
 * 主进程每次发起关闭请求都会启动一个兜底超时：
 * cancelCloseWindow() 取消超时（窗口保持打开）；
 * confirmCloseWindow() 取消超时并销毁窗口。
 *
 * 本 hook 应在应用根组件中调用一次。
 */
export function useWindowCloseHandler() {
  const { hasOpenLayers, closeTop } = useDismissibleLayerRegistry()
  const { hasOpenModals, closeTopModal } = useModalRegistry()
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const closePanel = useSetAtom(closePanelAtom)

  useEffect(() => {
    const cleanup = window.electronAPI.onCloseRequested((request: WindowCloseRequest) => {
      if (request.source === 'window-button') {
        window.electronAPI.confirmCloseWindow()
        return
      }

      if (hasOpenLayers()) {
        closeTop()
        window.electronAPI.cancelCloseWindow()
        return
      }

      // 兼容尚未迁移到 DismissibleLayer 的旧 modal
      if (hasOpenModals()) {
        closeTopModal()
        window.electronAPI.cancelCloseWindow()
        return
      }

      // 关闭当前聚焦的 panel（如果没有追踪焦点，则关闭最后一个）
      const target = focusedPanelId
        ? panelStack.find(p => p.id === focusedPanelId)
        : panelStack[panelStack.length - 1]
      if (target) {
        closePanel(target.id)
        window.electronAPI.cancelCloseWindow()
      } else {
        // 没有 panel 也没有 modal，真正关闭窗口
        window.electronAPI.confirmCloseWindow()
      }
    })

    return cleanup
  }, [hasOpenLayers, closeTop, hasOpenModals, closeTopModal, panelStack, focusedPanelId, closePanel])
}
