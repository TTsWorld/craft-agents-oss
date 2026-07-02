import { useRef, useEffect, useCallback } from "react"
import { useFocusContext, type FocusZoneId, type FocusIntent, type FocusZoneOptions } from "@/context/FocusContext"

interface UseFocusZoneOptions {
  /** 焦点区域唯一标识 */
  zoneId: FocusZoneId
  /** 区域获得焦点时回调 */
  onFocus?: () => void
  /** 区域失去焦点时回调 */
  onBlur?: () => void
  /** 自定义聚焦区域内第一个元素的函数 */
  focusFirst?: () => void
  /** 是否注册该区域。多个实例共享同一逻辑区域时可禁用 */
  enabled?: boolean
}

interface UseFocusZoneReturn {
  /** 绑定到区域容器的 ref */
  zoneRef: React.RefObject<HTMLDivElement>
  /** 当前区域是否拥有焦点 */
  isFocused: boolean
  /** 是否应把 DOM 焦点移入该区域（仅在显式键盘导航时为 true） */
  shouldMoveDOMFocus: boolean
  /** 当前焦点的意图（键盘、点击、程序化），若焦点不在本区域则为 null */
  intent: FocusIntent | null
  /** 程序化聚焦该区域 */
  focus: (options?: FocusZoneOptions) => void
}

/**
 * 注册一个组件为焦点区域（focus zone）。
 * 可用 Tab/Shift+Tab 或 Cmd+1/2/3 在区域之间导航。
 */
export function useFocusZone({
  zoneId,
  onFocus,
  onBlur,
  focusFirst,
  enabled = true,
}: UseFocusZoneOptions): UseFocusZoneReturn {
  const zoneRef = useRef<HTMLDivElement>(null)
  const { registerZone, unregisterZone, focusZone, isZoneFocused, focusState } = useFocusContext()

  const isFocused = enabled && isZoneFocused(zoneId)
  // 只有当本区域处于焦点且意图要求移动 DOM 焦点时才为 true
  const shouldMoveDOMFocus = enabled && focusState.zone === zoneId && focusState.shouldMoveDOMFocus
  // 意图只在焦点位于本区域时有意义
  const intent = focusState.zone === zoneId ? focusState.intent : null

  // 记录上一次焦点状态，用于触发焦点变化回调
  const wasFocusedRef = useRef(isFocused)

  // mount 时注册区域，并在容器上标记 data 属性以便基于 DOM 检测区域
  useEffect(() => {
    if (!enabled) {
      unregisterZone(zoneId)
      return
    }

    if (zoneRef.current) {
      zoneRef.current.setAttribute('data-focus-zone', zoneId)
    }

    registerZone({
      id: zoneId,
      ref: zoneRef as React.RefObject<HTMLElement>,
      focusFirst,
    })

    return () => {
      unregisterZone(zoneId)
    }
  }, [zoneId, registerZone, unregisterZone, focusFirst, enabled])

  // 处理焦点获得/失去回调
  useEffect(() => {
    if (isFocused && !wasFocusedRef.current) {
      onFocus?.()
    } else if (!isFocused && wasFocusedRef.current) {
      onBlur?.()
    }
    wasFocusedRef.current = isFocused
  }, [isFocused, onFocus, onBlur])

  const focus = useCallback((options?: FocusZoneOptions) => {
    focusZone(zoneId, options)
  }, [focusZone, zoneId])

  return {
    zoneRef,
    isFocused,
    shouldMoveDOMFocus,
    intent,
    focus,
  }
}
