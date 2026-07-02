import React, { createContext, useContext, useCallback, useRef } from 'react'

/**
 * 弹窗（Modal）注册表上下文
 *
 * 负责跟踪当前打开的弹窗，用于分层关闭：
 * 当用户按 Cmd+W（或类似关闭快捷键）时，先检查这里有没有打开的弹窗；
 * 如果有，就关闭最上层弹窗，而不是直接关闭面板或窗口。
 *
 * 弹窗注册时需要提供优先级（priority，数字越大越先被关闭）和关闭回调。
 * 可以理解为 Go 里一个带优先级的栈，但它是无序 Map + 排序实现的。
 */

interface RegisteredModal {
  /** 弹窗唯一标识，用于在注册表中查找/注销 */
  id: string
  /** 关闭优先级：数字越大越优先被关闭 */
  priority: number
  /** 实际关闭弹窗的回调 */
  close: () => void
}

interface ModalContextValue {
  /** 弹窗打开时注册自己，返回用于清理的“注销函数” */
  registerModal: (id: string, close: () => void, priority?: number) => () => void
  /** 检查当前是否有弹窗打开 */
  hasOpenModals: () => boolean
  /** 关闭最上层的弹窗（优先级最高），成功返回 true */
  closeTopModal: () => boolean
}

const ModalContext = createContext<ModalContextValue | null>(null)

/**
 * ModalProvider：把弹窗注册表能力注入子树
 * 用 Provider 包裹应用后，Cmd+W 等关闭操作就能先处理弹窗。
 */
export function ModalProvider({ children }: { children: React.ReactNode }) {
  // 用 useRef 而不是 useState 保存注册表，避免弹窗注册/注销时触发整树重渲染。
  // UI 不需要知道注册表本身，只有关闭快捷键需要读取它。
  const modalsRef = useRef<Map<string, RegisteredModal>>(new Map())

  const registerModal = useCallback((id: string, close: () => void, priority = 0) => {
    modalsRef.current.set(id, { id, priority, close })

    // 返回注销函数，组件卸载或弹窗关闭时调用
    return () => {
      modalsRef.current.delete(id)
    }
  }, [])

  const hasOpenModals = useCallback(() => {
    return modalsRef.current.size > 0
  }, [])

  const closeTopModal = useCallback(() => {
    const modals = Array.from(modalsRef.current.values())
    if (modals.length === 0) return false

    // 按优先级降序排列，关闭优先级最高的弹窗
    modals.sort((a, b) => b.priority - a.priority)
    const topModal = modals[0]
    topModal.close()
    return true
  }, [])

  const value: ModalContextValue = {
    registerModal,
    hasOpenModals,
    closeTopModal,
  }

  return (
    <ModalContext.Provider value={value}>
      {children}
    </ModalContext.Provider>
  )
}

/**
 * 访问弹窗注册表功能的 Hook
 */
export function useModalRegistry() {
  const context = useContext(ModalContext)
  if (!context) {
    throw new Error('useModalRegistry must be used within a ModalProvider')
  }
  return context
}

/**
 * 在弹窗组件里调用这个 Hook 来自行注册。
 * 弹窗关闭或组件卸载时会自动注销。
 *
 * @param isOpen - 弹窗是否正在显示
 * @param onClose - 关闭弹窗的回调
 * @param priority - 优先级越高越先被关闭（默认 0）
 *
 * @example
 * ```tsx
 * function MyDialog({ open, onClose }) {
 *   useRegisterModal(open, onClose)
 *   return <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>...</Dialog>
 * }
 * ```
 */
export function useRegisterModal(isOpen: boolean, onClose: () => void, priority = 0) {
  const { registerModal } = useModalRegistry()
  const idRef = useRef(`modal-${Math.random().toString(36).slice(2)}`)

  React.useEffect(() => {
    if (isOpen) {
      const unregister = registerModal(idRef.current, onClose, priority)
      return unregister
    }
  }, [isOpen, onClose, priority, registerModal])
}
