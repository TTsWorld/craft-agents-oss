/**
 * Update Checker Hook
 *
 * 管理 Electron 应用的自动更新状态。
 * - 监听主进程广播的更新可用事件
 * - 跟踪下载进度
 * - 提供手动检查更新与安装方法
 * - 更新就绪时显示 toast 通知
 * - 支持按版本持久化忽略（跨应用重启）
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { UpdateInfo } from '../../shared/types'

interface UseUpdateCheckerResult {
  /** 当前更新信息 */
  updateInfo: UpdateInfo | null
  /** 是否有可用更新 */
  updateAvailable: boolean
  /** 是否正在下载更新 */
  isDownloading: boolean
  /** 更新是否已准备好安装 */
  isReadyToInstall: boolean
  /** 下载进度 0-100 */
  downloadProgress: number
  /** 手动检查更新 */
  checkForUpdates: () => Promise<void>
  /** 安装已下载的更新并重启 */
  installUpdate: () => Promise<void>
}

// 更新通知的 toast ID，便于取消或更新同一条 toast
const UPDATE_TOAST_ID = 'update-available'

export function useUpdateChecker(): UseUpdateCheckerResult {
  const { t } = useTranslation()
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  // 记录当前会话是否已为该版本展示过 toast，避免重复
  const shownToastVersionRef = useRef<string | null>(null)

  // 更新就绪时显示 toast
  const showUpdateToast = useCallback((version: string, onInstall: () => void) => {
    // 同一会话中已展示过则跳过
    if (shownToastVersionRef.current === version) {
      return
    }
    shownToastVersionRef.current = version

    toast.info(t('toast.updateReady', { version }), {
      id: UPDATE_TOAST_ID,
      description: t('toast.restartToApply'),
      duration: 10000, // 10 秒后自动消失
      action: {
        label: t('toast.restart'),
        onClick: onInstall,
      },
      onDismiss: () => {
        // 持久化忽略该版本，避免应用重启后再次弹出
        window.electronAPI.dismissUpdate(version)
      },
    })
  }, [t])

  // 安装更新
  const installUpdate = useCallback(async () => {
    try {
      // 先关闭更新 toast
      toast.dismiss(UPDATE_TOAST_ID)
      toast.info(t('toast.installingUpdate'), {
        description: t('toast.appWillRestart'),
        duration: 5000,
      })
      await window.electronAPI.installUpdate()
    } catch (error) {
      console.error('[useUpdateChecker] Install failed:', error)
      toast.error(t('toast.failedToInstallUpdate'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [])

  // 加载初始状态并监听更新事件
  useEffect(() => {
    const checkAndNotify = async (info: UpdateInfo) => {
      if (!info.available || !info.latestVersion) return
      if (info.downloadState !== 'ready') return

      // 检查该版本是否被用户忽略过
      const dismissedVersion = await window.electronAPI.getDismissedUpdateVersion()
      if (dismissedVersion === info.latestVersion) {
        return
      }

      // 展示就绪提示
      showUpdateToast(info.latestVersion, installUpdate)
    }

    // 获取初始更新信息
    window.electronAPI.getUpdateInfo().then((info) => {
      setUpdateInfo(info)
      checkAndNotify(info)
    })

    // 订阅更新可用变化
    const cleanupAvailable = window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo(info)
      checkAndNotify(info)
    })

    // 订阅下载进度
    const cleanupProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
      setUpdateInfo((prev) => prev ? { ...prev, downloadProgress: progress } : prev)
    })

    return () => {
      cleanupAvailable()
      cleanupProgress()
    }
  }, [showUpdateToast, installUpdate])

  // 手动检查更新
  const checkForUpdates = useCallback(async () => {
    try {
      const info = await window.electronAPI.checkForUpdates()
      setUpdateInfo(info)

      if (!info.available) {
        toast.success(t('toast.upToDate'), {
          description: t('toast.versionIsLatest', { version: info.currentVersion }),
          duration: 3000,
        })
      } else if (info.downloadState === 'ready' && info.latestVersion) {
        // 已下载完成：清除之前的忽略记录，允许再次提示
        shownToastVersionRef.current = null
        showUpdateToast(info.latestVersion, installUpdate)
      }
    } catch (error) {
      console.error('[useUpdateChecker] Check failed:', error)
      toast.error(t('toast.failedToCheckUpdates'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [showUpdateToast, installUpdate])

  return {
    updateInfo,
    updateAvailable: updateInfo?.available ?? false,
    isDownloading: updateInfo?.downloadState === 'downloading',
    isReadyToInstall: updateInfo?.downloadState === 'ready',
    downloadProgress: updateInfo?.downloadProgress ?? 0,
    checkForUpdates,
    installUpdate,
  }
}
