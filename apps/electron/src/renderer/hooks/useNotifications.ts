/**
 * Notifications Hook
 *
 * 处理原生系统通知与 Dock 角标绘制。
 * - 跟踪窗口焦点状态
 * - 窗口失去焦点时对新消息显示通知
 * - 通过 Canvas API 绘制角标图标（主进程直接控制角标数量）
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Session } from '../../shared/types'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'

/**
 * 用 Canvas 在应用图标上绘制角标，返回带角标的图片 data URL。
 */
function drawBadgeOnIcon(iconDataUrl: string, count: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      // 创建与图标等大的 canvas，至少 256px 以保证清晰度
      const canvas = document.createElement('canvas')
      const size = Math.max(img.width, img.height, 256)
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Could not get canvas context'))
        return
      }

      // 将原图标居中绘制
      const offsetX = (size - img.width) / 2
      const offsetY = (size - img.height) / 2
      ctx.drawImage(img, offsetX, offsetY, img.width, img.height)

      // 角标参数
      const badgeRadius = size * 0.19
      // 相对于 256px 图标偏移 8px，按比例缩放
      const offsetPx = (8 / 256) * size
      const badgeX = size - badgeRadius - (size * 0.05) + offsetPx
      const badgeY = badgeRadius + (size * 0.05) - offsetPx
      const text = count > 99 ? '99+' : count.toString()

      // 红色圆形角标，带阴影
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
      ctx.shadowBlur = size * 0.06
      ctx.shadowOffsetY = size * 0.015

      ctx.beginPath()
      ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2)
      ctx.fillStyle = '#FF3B30'  // iOS/macOS 红
      ctx.fill()

      // 清除阴影，准备绘制文字
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0

      // 白色文字
      const fontSize = count > 99 ? badgeRadius * 0.65 : badgeRadius * 0.95
      ctx.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.fillStyle = '#FFFFFF'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, badgeX, badgeY)

      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load icon image'))
    img.src = iconDataUrl
  })
}

/**
 * 绘制 Windows 任务栏覆盖角标（透明背景 + 红色圆形）。
 */
function drawWindowsBadgeOverlay(count: number): string {
  const canvas = document.createElement('canvas')
  const size = 32
  canvas.width = size
  canvas.height = size

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Could not get canvas context')
  }

  const text = count > 99 ? '99+' : count.toString()
  const badgeRadius = size * 0.46
  const badgeX = size / 2
  const badgeY = size / 2

  // 微弱阴影，让角标在不同颜色任务栏上都可见
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
  ctx.shadowBlur = 3
  ctx.shadowOffsetY = 1

  ctx.beginPath()
  ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2)
  ctx.fillStyle = '#FF3B30'
  ctx.fill()

  // 清除阴影后绘制文字
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  const fontSize = count > 99 ? size * 0.34 : size * 0.48
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, badgeX, badgeY)

  return canvas.toDataURL('image/png')
}

interface UseNotificationsOptions {
  /** 当前工作区 ID */
  workspaceId: string | null
  /** 点击通知时跳转到对应会话的回调 */
  onNavigateToSession?: (sessionId: string) => void
  /** 设置中是否启用通知 */
  enabled?: boolean
}

interface UseNotificationsResult {
  /** 当前窗口是否处于焦点状态 */
  isWindowFocused: boolean
  /** 为某个会话显示通知 */
  showSessionNotification: (session: Session, messagePreview?: string) => void
}

export function useNotifications({
  workspaceId,
  onNavigateToSession,
  enabled = true,
}: UseNotificationsOptions): UseNotificationsResult {
  const [isWindowFocused, setIsWindowFocused] = useState(true)
  const onNavigateToSessionRef = useRef(onNavigateToSession)

  // 检查当前服务器是否支持 GUI 通知通道（无头服务器不支持）
  const hasGuiChannels = useMemo(
    () => window.electronAPI.isChannelAvailable(RPC_CHANNELS.notification.SHOW),
    [],
  )

  // 保持 ref 最新
  useEffect(() => {
    onNavigateToSessionRef.current = onNavigateToSession
  }, [onNavigateToSession])

  // 订阅窗口焦点变化
  useEffect(() => {
    if (!hasGuiChannels) return

    // 获取初始焦点状态
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)

    // 订阅焦点变化
    const cleanup = window.electronAPI.onWindowFocusChange((isFocused) => {
      setIsWindowFocused(isFocused)
    })

    return cleanup
  }, [hasGuiChannels])

  // 订阅通知点击跳转
  useEffect(() => {
    if (!hasGuiChannels) return

    const cleanup = window.electronAPI.onNotificationNavigate((data) => {
      onNavigateToSessionRef.current?.(data.sessionId)
    })

    return cleanup
  }, [hasGuiChannels])

  // 订阅主进程发起的角标绘制请求
  // 这里使用 renderer 中才有的 Canvas API 在图标上绘制角标
  useEffect(() => {
    if (!hasGuiChannels) return

    const cleanup = window.electronAPI.onBadgeDraw(async (data) => {
      try {
        const badgedIconDataUrl = await drawBadgeOnIcon(data.iconDataUrl, data.count)
        await window.electronAPI.setDockIconWithBadge(badgedIconDataUrl)
      } catch (error) {
        console.error('[Notifications] Failed to draw badge:', error)
      }
    })

    // Canvas 监听器注册完成后，请求主进程刷新一次角标
    void window.electronAPI.refreshBadge()

    return cleanup
  }, [hasGuiChannels])

  // 订阅 Windows 任务栏覆盖角标绘制请求
  useEffect(() => {
    if (!hasGuiChannels) return

    const cleanup = window.electronAPI.onBadgeDrawWindows(async (data) => {
      try {
        const overlayDataUrl = drawWindowsBadgeOverlay(data.count)
        await window.electronAPI.setDockIconWithBadge(overlayDataUrl)
      } catch (error) {
        console.error('[Notifications] Failed to draw Windows badge overlay:', error)
      }
    })

    return cleanup
  }, [hasGuiChannels])

  // 显示会话通知
  const showSessionNotification = useCallback((session: Session, messagePreview?: string) => {
    // 设置中禁用时直接返回
    if (!enabled) return
    // 窗口处于焦点时不打扰
    if (isWindowFocused) return
    // 没有工作区时不显示
    if (!workspaceId) return
    // 服务器没有 GUI 通知处理器时不显示
    if (!hasGuiChannels) return

    // 通知标题
    const title = session.name || 'New message'

    // 通知正文，超长则截断
    let body = messagePreview || 'Craft Agent has a new message for you'
    if (body.length > 100) {
      body = body.substring(0, 97) + '...'
    }

    window.electronAPI.showNotification(title, body, workspaceId, session.id)
  }, [enabled, isWindowFocused, workspaceId, hasGuiChannels])

  return {
    isWindowFocused,
    showSessionNotification,
  }
}
