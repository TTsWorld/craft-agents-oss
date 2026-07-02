import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { useTransportConnectionState } from './useTransportConnectionState'
import { toast } from 'sonner'

type ServerBrowserMode = 'browse' | 'manual'

interface DirectoryPickerResult {
  /** 打开目录选择器（本地模式用原生对话框，远程模式用 ServerDirectoryBrowser） */
  pickDirectory: () => void
  /** 是否应渲染 ServerDirectoryBrowser 弹窗 */
  showServerBrowser: boolean
  /** ServerDirectoryBrowser 的工作模式 */
  serverBrowserMode: ServerBrowserMode
  /** 取消服务器端目录浏览，不选择路径 */
  cancelServerBrowser: () => void
  /** 从服务器端目录浏览器确认选择某路径 */
  confirmServerBrowser: (path: string) => void
  /** 当前是否处于远程模式（仅作信息展示） */
  isRemote: boolean
}

/**
 * 目录选择器 hook。
 *
 * 根据当前连接模式自动选择：
 * - 本地模式：调用 Electron 原生 openFolderDialog
 * - 远程模式：弹出 ServerDirectoryBrowser，支持浏览或手动输入路径
 */
export function useDirectoryPicker(
  onSelect: (path: string) => void
): DirectoryPickerResult {
  const { t } = useTranslation()
  const connectionState = useTransportConnectionState()
  const isRemote = connectionState?.mode === 'remote'
  const canBrowse = isRemote &&
    window.electronAPI.isChannelAvailable(RPC_CHANNELS.fs.LIST_DIRECTORY)

  const [showServerBrowser, setShowServerBrowser] = useState(false)

  const serverBrowserMode: ServerBrowserMode = canBrowse ? 'browse' : 'manual'

  const pickDirectory = useCallback(async () => {
    if (isRemote) {
      // 远程模式：打开服务器端目录浏览器（根据服务器能力决定浏览或手动）
      setShowServerBrowser(true)
      return
    }

    // 本地模式：调用操作系统原生对话框
    try {
      const path = await window.electronAPI.openFolderDialog()
      if (path) onSelect(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.failedToOpenFolderPicker'), {
        description: message,
      })
    }
  }, [isRemote, onSelect])

  const cancelServerBrowser = useCallback(() => {
    setShowServerBrowser(false)
  }, [])

  const confirmServerBrowser = useCallback((path: string) => {
    setShowServerBrowser(false)
    onSelect(path)
  }, [onSelect])

  return {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
    isRemote,
  }
}
