/**
 * Action Registry（动作注册表）。
 *
 * 作为 React Context 提供：
 * 1. 维护每个 action 对应的 handler 列表（register/execute）。
 * 2. 监听全局 keydown，匹配快捷键后按 when 条件决定要不要执行。
 * 3. 提供快捷键显示字符串（如 Mac 上 "⌘N"，Windows 上 "Ctrl+N"）。
 *
 * 对 Golang 同学：可以把它理解为一个带事件分发和快捷键路由的命令注册中心，
 * 但实现上必须放在 React 组件树里，通过 Context 供子组件消费。
 */
import React, { createContext, useContext, useCallback, useRef, useEffect } from 'react'
import { actions, type ActionId } from './definitions'
import type { ActionDefinition, ActionHandler } from './types'
import { isMac } from '@/lib/platform'
import { getKeybindingContext, evaluateWhen } from './keybinding-context'

/** Context 暴露给子组件的 API 类型。 */
interface ActionRegistryContextType {
  /** 注册某个 action 的 handler，返回取消注册的函数 */
  register: (handler: ActionHandler) => () => void

  /** 按 ID 执行 action（会找到第一个 enabled 的 handler 执行） */
  execute: (actionId: ActionId) => void

  /** 获取 action 当前的快捷键（优先用户自定义覆盖） */
  getHotkey: (actionId: ActionId) => string | null

  /** 获取给 UI 展示的快捷键字符串，如 "⌘N" 或 "Ctrl+N" */
  getHotkeyDisplay: (actionId: ActionId) => string | null

  /** 获取 action 的元数据定义 */
  getAction: (actionId: ActionId) => typeof actions[ActionId]

  /** 用户自定义快捷键覆盖（预留，未来从配置读取） */
  userOverrides: Map<ActionId, string | null>
}

// createContext 创建一个 React Context（类似 Go 里的 context，但更偏向“跨组件共享状态”）。
// Provider 包裹子组件树，子组件用 useContext 读取这里提供的方法。
const ActionRegistryContext = createContext<ActionRegistryContextType | null>(null)

export function ActionRegistryProvider({ children }: { children: React.ReactNode }) {
  // useRef 返回一个在组件整个生命周期里保持不变的可变容器，
  // 修改 .current 不会触发重新渲染，适合放 handler 列表这种纯数据。
  const handlersRef = useRef<Map<ActionId, ActionHandler[]>>(new Map())
  const userOverrides = useRef<Map<ActionId, string | null>>(new Map())

  /** 注册 handler：把 handler 按 actionId 分组存到 ref 里。
   *  useCallback 缓存函数引用，避免每次渲染都生成新函数，减少不必要的子组件重渲染。 */
  const register = useCallback((handler: ActionHandler) => {
    const handlers = handlersRef.current.get(handler.actionId) || []
    handlers.push(handler)
    handlersRef.current.set(handler.actionId, handlers)

    // 返回取消注册的 cleanup 函数，组件卸载时调用
    return () => {
      const handlers = handlersRef.current.get(handler.actionId) || []
      const index = handlers.indexOf(handler)
      if (index > -1) handlers.splice(index, 1)
    }
  }, [])

  /** 执行 action：找到该 action 下第一个 enabled 的 handler 执行。 */
  const execute = useCallback((actionId: ActionId) => {
    const handlers = handlersRef.current.get(actionId) || []
    for (const handler of handlers) {
      if (!handler.enabled || handler.enabled()) {
        handler.handler()
        break // 只执行第一个 enabled 的 handler
      }
    }
  }, [])

  /** 获取 action 的快捷键：优先看用户覆盖，否则用默认快捷键。 */
  const getHotkey = useCallback((actionId: ActionId): string | null => {
    if (userOverrides.current.has(actionId)) {
      return userOverrides.current.get(actionId) ?? null
    }
    return actions[actionId].defaultHotkey
  }, [])

  /** 获取给 UI 展示的快捷键字符串。 */
  const getHotkeyDisplay = useCallback((actionId: ActionId): string | null => {
    const hotkey = getHotkey(actionId)
    if (!hotkey) return null
    return formatHotkeyDisplay(hotkey)
  }, [getHotkey])

  /** 获取 action 的元数据定义。 */
  const getAction = useCallback((actionId: ActionId) => {
    return actions[actionId]
  }, [])

  /** 设置全局 keydown 监听器，在捕获阶段拦截快捷键。
   *  useEffect 是 React 的副作用钩子：组件挂载后执行、卸载前清理，
   *  类似在生命周期里注册/反注册事件监听。 */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 根据当前 DOM 状态生成上下文快照
      const context = getKeybindingContext(e)

      // 遍历所有 action，找匹配的快捷键
      for (const [actionId, action] of Object.entries(actions)) {
        const hotkey = getHotkey(actionId as ActionId)
        if (!hotkey || !matchesHotkey(e, hotkey)) continue

        // 用 when 条件判断当前场景是否允许触发
        if (!evaluateWhen((action as ActionDefinition).when, context)) continue

        const handlers = handlersRef.current.get(actionId as ActionId) || []
        for (const handler of handlers) {
          if (!handler.enabled || handler.enabled()) {
            e.preventDefault()
            e.stopPropagation()
            handler.handler()
            return
          }
        }
      }
    }

    // 用捕获阶段（true）优先拦截，避免被输入框等默认行为吞掉
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [getHotkey])

  const value: ActionRegistryContextType = {
    register,
    execute,
    getHotkey,
    getHotkeyDisplay,
    getAction,
    userOverrides: userOverrides.current,
  }

  // JSX：Provider 是 React 组件，value 是传给子组件的上下文数据。
  // 所有被它包裹的后代组件都能通过 useActionRegistry() 拿到这些方法。
  return (
    <ActionRegistryContext.Provider value={value}>
      {children}
    </ActionRegistryContext.Provider>
  )
}

/** 自定义 Hook：让子组件消费 ActionRegistryContext。
 *  如果不在 Provider 内调用会抛错，防止在错误位置使用。 */
export function useActionRegistry() {
  const context = useContext(ActionRegistryContext)
  if (!context) {
    throw new Error('useActionRegistry must be used within ActionRegistryProvider')
  }
  return context
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/** 判断当前键盘事件是否匹配给定的快捷键字符串（如 'mod+shift+a'）。 */
function matchesHotkey(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needsMod = parts.includes('mod')
  const needsShift = parts.includes('shift')
  const needsAlt = parts.includes('alt')

  const modPressed = isMac ? e.metaKey : e.ctrlKey
  const logicalKeyMatches = e.key.toLowerCase() === key

  // 特殊按键用物理 code 匹配，因为不同键盘布局下逻辑 key 可能不一样。
  const specialKeys: Record<string, string> = {
    '[': 'BracketLeft',
    ']': 'BracketRight',
    ',': 'Comma',
    '.': 'Period',
    'left': 'ArrowLeft',
    'right': 'ArrowRight',
    'up': 'ArrowUp',
    'down': 'ArrowDown',
    'escape': 'Escape',
    'tab': 'Tab',
  }

  const specialCode = specialKeys[key]

  // 注意：A-Z/0-9 这类文本快捷键只用逻辑 key 匹配。
  // 如果混用物理 code（例如 KeyQ），在 AZERTY/QWERTZ 键盘布局下会出错，
  // 导致 Cmd+A 错误地匹配到 Cmd+Q 的绑定。
  const codeMatches = specialCode
    ? e.code === specialCode
    : logicalKeyMatches

  // 检查修饰键是否满足要求
  const modCorrect = needsMod ? modPressed : !modPressed
  const shiftCorrect = needsShift ? e.shiftKey : !e.shiftKey
  const altCorrect = needsAlt ? e.altKey : !e.altKey

  return codeMatches && modCorrect && shiftCorrect && altCorrect
}

/** 把内部快捷键格式（如 'mod+n'）转换成展示字符串（Mac 用符号，Windows 用 '+' 连接）。 */
function formatHotkeyDisplay(hotkey: string): string {
  const parts = hotkey.toLowerCase().split('+')

  const symbols = parts.map(part => {
    if (part === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (part === 'shift') return isMac ? '⇧' : 'Shift'
    if (part === 'alt') return isMac ? '⌥' : 'Alt'
    if (part === 'escape') return 'Esc'
    if (part === 'tab') return 'Tab'
    if (part === 'left') return '←'
    if (part === 'right') return '→'
    if (part === '[') return '['
    if (part === ']') return ']'
    return part.toUpperCase()
  })

  return isMac ? symbols.join('') : symbols.join('+')
}
