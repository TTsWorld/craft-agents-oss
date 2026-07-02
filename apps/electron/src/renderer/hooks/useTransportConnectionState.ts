import { useEffect, useRef, useState } from 'react'
import type { TransportConnectionState } from '../../shared/types'

/**
 * 非 connected 状态的防抖延迟（毫秒）。
 * 用于吸收单次重连周期内的快速状态切换（如 reconnecting → failed → reconnecting），
 * 避免顶部提示条闪烁。connected 状态立即展示，不延迟。
 */
const DEBOUNCE_MS = 300

/**
 * 监听与后端的传输层连接状态。
 *
 * 远程模式（remote）下 Electron 与服务器之间通过 WebSocket/IPC 维持连接；
 * 该 hook 把状态同步到 React 组件，用于显示断线/重连提示。
 */
export function useTransportConnectionState(): TransportConnectionState | null {
  const [state, setState] = useState<TransportConnectionState | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let mounted = true

    const readInitialState = async () => {
      if (!window.electronAPI.getTransportConnectionState) return
      try {
        const initial = await window.electronAPI.getTransportConnectionState()
        if (mounted) {
          setState(initial)
        }
      } catch {
        // 尽力而为：如果 preload 状态不可用，不要让渲染进程崩溃
      }
    }

    void readInitialState()

    const unsubscribe = window.electronAPI.onTransportConnectionStateChanged?.((next) => {
      if (!mounted) return

      // connected 状态立即展示（好消息不延迟）
      if (next.status === 'connected') {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current)
          debounceRef.current = null
        }
        setState(next)
        return
      }

      // 非 connected 状态：防抖，避免单次重连周期内的闪烁
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        if (mounted) setState(next)
      }, DEBOUNCE_MS)
    })

    return () => {
      mounted = false
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      unsubscribe?.()
    }
  }, [])

  return state
}
