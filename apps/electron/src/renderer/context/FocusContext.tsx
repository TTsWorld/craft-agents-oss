import * as React from "react"
import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react"
import { setCurrentZone } from '@/actions/keybinding-context'

/**
 * 焦点区域（Focus Zone）上下文
 *
 * 把界面分成三个主要区域：sidebar（侧边栏）、navigator（导航器）、chat（聊天区）。
 * 通过 Tab / Shift+Tab 或快捷键（如 Cmd+1/2/3）在区域间切换焦点。
 *
 * 同时记录“焦点意图（intent）”，让组件知道焦点是怎么过来的：
 * 键盘导航、鼠标点击，还是代码主动设置。不同来源的默认行为不一样。
 */

// 焦点区域 ID，顺序决定 Tab 切换的先后
export type FocusZoneId = 'sidebar' | 'navigator' | 'chat'

/**
 * 焦点意图：描述焦点为什么发生变化
 * - 'keyboard'：用户用键盘主动导航（Cmd+1/2/3、Tab、方向键）
 * - 'click'：用户在某个区域内点击
 * - 'programmatic'：代码主动触发的焦点变化（例如激活搜索）
 */
export type FocusIntent = 'keyboard' | 'click' | 'programmatic'

/**
 * focusZone 调用的可选参数
 */
export interface FocusZoneOptions {
  /** 焦点变化的原因，影响默认的 moveFocus 行为 */
  intent?: FocusIntent
  /** 是否把 DOM 焦点真正移到该区域；默认 keyboard=true、click=false、programmatic=true */
  moveFocus?: boolean
}

// 区域顺序数组：Tab 按这个顺序循环
const ZONE_ORDER: FocusZoneId[] = ['sidebar', 'navigator', 'chat']

interface FocusZone {
  /** 区域 ID，决定 Tab 切换顺序 */
  id: FocusZoneId
  /** 指向区域 DOM 节点的 ref，用于把焦点真正移过去 */
  ref: React.RefObject<HTMLElement>
  /** 可选：自定义焦点进入行为（例如选中列表第一项） */
  focusFirst?: () => void
}

/**
 * 焦点状态：同时记录当前激活区域和触发意图
 */
interface FocusState {
  zone: FocusZoneId | null
  intent: FocusIntent | null
  shouldMoveDOMFocus: boolean
}

interface FocusContextValue {
  /** 当前获得焦点的区域 */
  currentZone: FocusZoneId | null
  /** 包含意图信息的完整焦点状态 */
  focusState: FocusState
  /** 注册一个区域（组件挂载时调用） */
  registerZone: (zone: FocusZone) => void
  /** 注销一个区域（组件卸载时调用） */
  unregisterZone: (id: FocusZoneId) => void
  /** 聚焦指定区域，可控制意图和是否真正移动 DOM 焦点 */
  focusZone: (id: FocusZoneId, options?: FocusZoneOptions) => void
  /** 聚焦下一个区域（Tab） */
  focusNextZone: () => void
  /** 聚焦上一个区域（Shift+Tab） */
  focusPreviousZone: () => void
  /** 判断某个区域当前是否处于聚焦状态 */
  isZoneFocused: (id: FocusZoneId) => boolean
}

const FocusContext = createContext<FocusContextValue | null>(null)

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [focusState, setFocusState] = useState<FocusState>({
    zone: null,
    intent: null,
    shouldMoveDOMFocus: false,
  })
  // 用 ref 保存所有注册的区域，避免区域注册/注销触发不必要的重渲染
  const zonesRef = useRef<Map<FocusZoneId, FocusZone>>(new Map())

  const registerZone = useCallback((zone: FocusZone) => {
    zonesRef.current.set(zone.id, zone)
  }, [])

  const unregisterZone = useCallback((id: FocusZoneId) => {
    zonesRef.current.delete(id)
  }, [])

  const focusZone = useCallback((id: FocusZoneId, options?: FocusZoneOptions) => {
    const zone = zonesRef.current.get(id)
    if (!zone) return

    const intent = options?.intent ?? 'programmatic'
    // 默认行为：键盘导航和代码触发会真正移动焦点，鼠标点击不移动
    const shouldMoveFocus = options?.moveFocus ?? (intent === 'keyboard' || intent === 'programmatic')

    setFocusState({
      zone: id,
      intent,
      shouldMoveDOMFocus: shouldMoveFocus,
    })

    // 同步到快捷键上下文，这样 when-clause（快捷键条件）能根据当前区域做判断
    setCurrentZone(id)

    // 只有明确需要移动焦点时才操作 DOM
    if (shouldMoveFocus) {
      if (zone.focusFirst) {
        zone.focusFirst()
      } else if (zone.ref.current) {
        zone.ref.current.focus()
      }
      // 焦点移动完成后把 shouldMoveDOMFocus 重置为 false，避免 effect 反复触发。
      // 先用 setTimeout(0) 让订阅者先看到 true，再变回 false。
      setTimeout(() => {
        setFocusState(prev => ({ ...prev, shouldMoveDOMFocus: false }))
      }, 0)
    }
  }, [])

  const focusNextZone = useCallback(() => {
    const currentIndex = focusState.zone ? ZONE_ORDER.indexOf(focusState.zone) : -1
    const nextIndex = (currentIndex + 1) % ZONE_ORDER.length
    // Tab 是明确的键盘意图，总是移动焦点
    focusZone(ZONE_ORDER[nextIndex], { intent: 'keyboard', moveFocus: true })
  }, [focusState.zone, focusZone])

  const focusPreviousZone = useCallback(() => {
    const currentIndex = focusState.zone ? ZONE_ORDER.indexOf(focusState.zone) : 0
    const prevIndex = (currentIndex - 1 + ZONE_ORDER.length) % ZONE_ORDER.length
    // Shift+Tab 也是明确的键盘意图，总是移动焦点
    focusZone(ZONE_ORDER[prevIndex], { intent: 'keyboard', moveFocus: true })
  }, [focusState.zone, focusZone])

  const isZoneFocused = useCallback((id: FocusZoneId) => {
    return focusState.zone === id
  }, [focusState.zone])

  // 注意：这里没有监听 focusin 事件来自动跟踪焦点，因为以前它会导致所有打开的标签页级联重渲染
  //（每次焦点变化 250-780ms）。现在焦点只能通过显式调用 focusZone() 改变（快捷键 Cmd+1/2/3、Tab）。
  // 如果组件需要在会话变化时自动聚焦，应该把 session?.id 作为 effect 依赖，而不是依赖 isFocused。

  const value: FocusContextValue = {
    currentZone: focusState.zone,
    focusState,
    registerZone,
    unregisterZone,
    focusZone,
    focusNextZone,
    focusPreviousZone,
    isZoneFocused,
  }

  return (
    <FocusContext.Provider value={value}>
      {children}
    </FocusContext.Provider>
  )
}

export function useFocusContext() {
  const context = useContext(FocusContext)
  if (!context) {
    throw new Error('useFocusContext must be used within a FocusProvider')
  }
  return context
}
