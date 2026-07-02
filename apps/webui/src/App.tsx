/**
 * Web UI 的顶层 App 组件。
 *
 * 主要职责：
 * 1. 从服务器获取 WebSocket 配置；
 * 2. 创建 web API adapter 并设置 window.electronAPI；
 * 3. 挂载 Electron renderer 的 App 组件。
 *
 * 移动端响应式由共享 renderer 组件里的容器查询处理，这里不需要额外布局。
 */

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { createWebApi } from './adapter/web-api'
import type { WsRpcClient } from '../../electron/src/transport/client'

// 懒加载 Electron 的 App 组件，确保 window.electronAPI 已就绪后再渲染
const ElectronApp = lazy(() => import('@/App'))

// 页面状态：加载中 / 出错 / 就绪
type Phase = 'loading' | 'error' | 'ready'

function LoadingScreen() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <div className="animate-spin w-6 h-6 border-2 border-current border-t-transparent rounded-full" />
      <p className="text-[13px]">{t("webui.connectingToServer")}</p>
    </div>
  )
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium text-destructive">{t("webui.connectionFailed")}</p>
      <p className="text-[13px] max-w-md text-center">{message}</p>
      <div className="flex gap-2 mt-2">
        <button
          onClick={onRetry}
          className="px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
        >
          {t("common.retry")}
        </button>
        <button
          onClick={() => {
            fetch('/api/auth/logout', { method: 'POST' }).then(() => {
              window.location.href = '/login'
            })
          }}
          className="px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
        >
          {t("webui.logOut")}
        </button>
      </div>
    </div>
  )
}

export default function App() {
  // useState<Phase> 是泛型写法，表示状态类型为 Phase
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  // useRef 保存可变值，切换/重试时不会触发重新渲染
  const clientRef = useRef<WsRpcClient | null>(null)
  const initRef = useRef(false)

  const initialize = async () => {
    setPhase('loading')
    setError('')

    try {
      // 1. 通过 cookie 认证获取 WS URL
      const configRes = await fetch('/api/config', { credentials: 'same-origin' })
      if (!configRes.ok) {
        if (configRes.status === 401) {
          // 会话过期，跳回登录页
          window.location.href = '/login'
          return
        }
        throw new Error(`Failed to fetch config: ${configRes.status}`)
      }

      // as { wsUrl: string } 把未知 JSON 断言为具体类型
      const { wsUrl } = await configRes.json() as { wsUrl: string }
      if (!wsUrl) throw new Error('Server did not return a WebSocket URL')

      // 2. 决定 workspace：优先从 URL 查询参数读取
      const params = new URLSearchParams(window.location.search)
      let workspaceId = params.get('workspace') ?? undefined

      // URL 里没有 workspace 时，从服务器取默认值，以便在 WebSocket 握手时带上
      if (!workspaceId) {
        try {
          const wsRes = await fetch('/api/config/workspaces', { credentials: 'same-origin' })
          if (wsRes.ok) {
            const { defaultWorkspaceId } = await wsRes.json() as { defaultWorkspaceId?: string }
            if (defaultWorkspaceId) workspaceId = defaultWorkspaceId
          }
        } catch {
          // 非致命错误，后面还能通过 switchWorkspace 设置 workspace
        }
      }

      // 3. 创建 web API adapter
      // 重试时先销毁之前的 client，避免连接泄漏
      if (clientRef.current) {
        clientRef.current.destroy()
      }

      const { api, client } = createWebApi({ serverUrl: wsUrl, workspaceId })
      clientRef.current = client

      // 4. 把 api 挂到 window.electronAPI 上，必须在任何 Electron 组件挂载前完成
      ;(window as any).electronAPI = api

      // 5. 发起 WebSocket 连接
      client.connect()

      setPhase('ready')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setPhase('error')
    }
  }

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true
      initialize()
    }

    return () => {
      // 组件卸载时清理 WebSocket 客户端
      clientRef.current?.destroy()
    }
  }, [])

  if (phase === 'loading') return <LoadingScreen />
  if (phase === 'error') return <ErrorScreen message={error} onRetry={initialize} />

  return (
    <Suspense fallback={<LoadingScreen />}>
      <ElectronApp />
    </Suspense>
  )
}
