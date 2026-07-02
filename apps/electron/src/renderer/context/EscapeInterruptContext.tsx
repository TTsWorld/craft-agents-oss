/**
 * EscapeInterruptContext（双 Esc 中断上下文）
 *
 * 当 AI 正在处理（processing）时，用户按一次 Esc 先显示警告遮罩，
 * 1 秒内再按一次 Esc 才真正中断处理。
 *
 * 单独抽成一个 Context，避免把状态通过 props 一层层从 AppShell 传到 FreeFormInput，
 * 这种跨层级传值在 React 里叫“prop drilling”，Context 就是用来解决它的。
 */

import * as React from 'react'
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

interface EscapeInterruptContextType {
  /** 是否显示 Esc 警告遮罩 */
  showEscapeOverlay: boolean
  /** 处理一次 Esc 按键：
   * - 第一次按：显示遮罩，返回 false（不要中断）
   * - 在超时时间内再按：关闭遮罩，返回 true（可以中断）
   */
  handleEscapePress: () => boolean
  /** 关闭遮罩（超时后或真正中断后调用） */
  dismissOverlay: () => void
}

const EscapeInterruptContext = createContext<EscapeInterruptContextType | null>(null)

// 第二次 Esc 按下的有效时间窗口（毫秒）
const ESC_TIMEOUT_MS = 2000

export function EscapeInterruptProvider({ children }: { children: React.ReactNode }) {
  const [showEscapeOverlay, setShowEscapeOverlay] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 组件卸载时清理定时器，防止内存泄漏
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const dismissOverlay = useCallback(() => {
    setShowEscapeOverlay(false)
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  /**
   * 处理 Esc 按键。
   * 返回 true 表示调用方应当继续执行中断（第二次按，且在超时内）。
   * 返回 false 表示这是第一次按（只显示遮罩，等待第二次）。
   */
  const handleEscapePress = useCallback((): boolean => {
    if (showEscapeOverlay) {
      // 第二次按，且在超时内，执行中断
      dismissOverlay()
      return true
    }

    // 第一次按，显示遮罩并启动超时
    setShowEscapeOverlay(true)

    // 清理已有的旧定时器，避免多个定时器互相覆盖
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    // 超时后自动关闭遮罩
    timeoutRef.current = setTimeout(() => {
      setShowEscapeOverlay(false)
      timeoutRef.current = null
    }, ESC_TIMEOUT_MS)

    return false
  }, [showEscapeOverlay, dismissOverlay])

  const value = React.useMemo(
    () => ({ showEscapeOverlay, handleEscapePress, dismissOverlay }),
    [showEscapeOverlay, handleEscapePress, dismissOverlay]
  )

  return (
    <EscapeInterruptContext.Provider value={value}>
      {children}
    </EscapeInterruptContext.Provider>
  )
}

export function useEscapeInterrupt(): EscapeInterruptContextType {
  const context = useContext(EscapeInterruptContext)
  if (!context) {
    throw new Error('useEscapeInterrupt must be used within an EscapeInterruptProvider')
  }
  return context
}
