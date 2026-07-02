/**
 * 面板栈状态
 *
 * 单通道（single-lane）的面板模型，用于并排展示内容面板。
 * 例如同时打开多个 session/source/settings 面板。
 *
 * Jotai atom 保存面板栈状态；读写操作通过 action atom 完成。
 */

import { atom } from 'jotai'
import { parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'

// 自增面板 ID 计数器。闭包变量，类似 Go 的局部变量。
let nextPanelId = 0
function generatePanelId(): string {
  return `panel-${++nextPanelId}-${Date.now()}`
}

/** 面板类型：会话 / 来源 / 设置 / 技能 / 其他。 */
export type PanelType = 'session' | 'source' | 'settings' | 'skills' | 'other'
/** 面板通道 ID；当前只有 'main' 一个通道。 */
export type PanelLaneId = 'main'
/** 打开意图：implicit（隐式打开）或 explicit（用户主动打开）。 */
export type OpenIntent = 'implicit' | 'explicit'

/** 面板通道策略：定义该通道允许哪些类型、是否锁定、是否为单例等。 */
export interface PanelLanePolicy {
  id: PanelLaneId
  order: number
  allowedTypes: PanelType[]
  locked: boolean
  singleton: boolean
}

/**
 * 通道策略表。Record<PanelLaneId, PanelLanePolicy> 等价于 Go 的 map[PanelLaneId]PanelLanePolicy。
 * 目前只有 main 通道，允许所有面板类型。
 */
export const PANEL_LANE_POLICIES: Record<PanelLaneId, PanelLanePolicy> = {
  main: {
    id: 'main',
    order: 0,
    allowedTypes: ['session', 'source', 'settings', 'skills', 'other'],
    locked: false,
    singleton: false,
  },
}

/** 面板栈条目：保存单个面板的 ID、路由、宽度比例、类型和所在通道。 */
export interface PanelStackEntry {
  id: string
  route: ViewRoute
  proportion: number
  panelType: PanelType
  laneId: PanelLaneId
}

/** 当前面板栈数组。空数组表示没有打开任何面板。 */
export const panelStackAtom = atom<PanelStackEntry[]>([])
/** 当前获得焦点的面板 ID。 */
export const focusedPanelIdAtom = atom<string | null>(null)

/** 派生 atom：当前栈里面板的数量。 */
export const panelCountAtom = atom((get) => get(panelStackAtom).length)

/** 派生 atom：当前焦点面板在栈中的索引。 */
export const focusedPanelIndexAtom = atom((get) => {
  const stack = get(panelStackAtom)
  const focusedId = get(focusedPanelIdAtom)
  if (!focusedId) return 0
  const idx = stack.findIndex(p => p.id === focusedId)
  return idx === -1 ? 0 : idx
})

/** 派生 atom：当前焦点面板对应的路由。 */
export const focusedPanelRouteAtom = atom((get) => {
  const stack = get(panelStackAtom)
  const idx = get(focusedPanelIndexAtom)
  return stack[idx]?.route ?? null
})

/**
 * 根据路由判断面板类型。
 * 先用 parseRouteToNavigationState 把路由字符串解析成导航状态，再映射到 PanelType。
 */
export function getPanelTypeFromRoute(route: ViewRoute): PanelType {
  const navState = parseRouteToNavigationState(route)
  if (!navState) return 'other'

  switch (navState.navigator) {
    case 'sessions':
      return 'session'
    case 'sources':
      return 'source'
    case 'settings':
      return 'settings'
    case 'skills':
      return 'skills'
    default:
      return 'other'
  }
}

/**
 * 返回某类面板默认所在的通道。
 * 当前所有类型都默认放到 main 通道，保留函数以便未来扩展。
 */
export function getDefaultLaneForType(_type: PanelType): PanelLaneId {
  return 'main'
}

/**
 * 创建一条面板栈条目。
 * id 可选，未提供时自动生成。
 */
function createEntry(route: ViewRoute, proportion: number, id?: string): PanelStackEntry {
  const panelType = getPanelTypeFromRoute(route)
  return {
    id: id ?? generatePanelId(),
    route,
    proportion,
    panelType,
    laneId: 'main',
  }
}

/**
 * 规范化面板宽度比例，使所有面板比例之和为 1。
 * 如果总和小于等于 0，则均分。
 */
function normalizeProportions(stack: PanelStackEntry[]): PanelStackEntry[] {
  if (stack.length === 0) return stack
  const total = stack.reduce((sum, p) => sum + p.proportion, 0)
  if (total <= 0) {
    const equal = 1 / stack.length
    return stack.map(p => ({ ...p, proportion: equal }))
  }
  return stack.map(p => ({ ...p, proportion: p.proportion / total }))
}

/**
 * 从路由字符串中解析出 session ID。
 * 例如 route 为 "/session/abc/..." 时返回 "abc"。
 */
export function parseSessionIdFromRoute(route: ViewRoute): string | null {
  // Strip any query string first — a `?x=y` tail on the last segment would otherwise
  // leak into the extracted session id and poison every focused-session consumer.
  const segments = route.split('?')[0].split('/')
  const idx = segments.indexOf('session')
  if (idx >= 0 && idx + 1 < segments.length) {
    return segments[idx + 1]
  }
  return null
}

/** 派生 atom：当前焦点面板所属的 session ID（如果不是 session 面板则返回 null）。 */
export const focusedSessionIdAtom = atom((get) => {
  const route = get(focusedPanelRouteAtom)
  if (!route) return null
  return parseSessionIdFromRoute(route)
})

/**
 * 当前所有打开面板（焦点面板以及分屏兄弟面板）中显示在屏幕上的 session ID 集合。
 * 用于判断某个 session 是否"在后台"——只要显示在任一面板中就不算后台。
 */
export const visibleSessionIdsAtom = atom((get) => {
  const ids = new Set<string>()
  for (const entry of get(panelStackAtom)) {
    const id = parseSessionIdFromRoute(entry.route)
    if (id) ids.add(id)
  }
  return ids
})

/**
 * Action atom：在面板栈中推入一个新面板。
 * afterIndex 指定插入位置；不指定则追加到末尾。
 */
export const pushPanelAtom = atom(
  null,
  (get, set, { route, afterIndex }: {
    route: ViewRoute
    afterIndex?: number
    targetLaneId?: PanelLaneId
    intent?: OpenIntent
  }) => {
    const stack = get(panelStackAtom)
    let insertAt = stack.length
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < stack.length) {
      insertAt = afterIndex + 1
    }

    const newEntry = createEntry(route, 0)
    const newStack = [
      ...stack.slice(0, insertAt),
      newEntry,
      ...stack.slice(insertAt),
    ]

    const normalized = normalizeProportions(newStack)
    set(panelStackAtom, normalized)
    set(focusedPanelIdAtom, newEntry.id)
  }
)

/**
 * Action atom：关闭指定 ID 的面板。
 * 如果关闭的是当前焦点面板，则把焦点移到相邻面板。
 */
export const closePanelAtom = atom(
  null,
  (get, set, id: string) => {
    const stack = get(panelStackAtom)
    const idx = stack.findIndex(p => p.id === id)
    if (idx === -1) return
    const remaining = [...stack.slice(0, idx), ...stack.slice(idx + 1)]

    set(panelStackAtom, normalizeProportions(remaining))

    if (get(focusedPanelIdAtom) === id) {
      const newIdx = Math.min(idx, remaining.length - 1)
      set(focusedPanelIdAtom, remaining[newIdx]?.id ?? null)
    }
  }
)

/**
 * Action atom：用外部传入的目标列表对面板栈进行协调/对齐。
 *
 * 用于持久化状态恢复或主进程同步：当外部给出一组期望的面板时，
 * 尽量复用现有面板的 ID，只更新路由和比例，减少 React 组件的卸载/重建。
 *
 * 返回 true 表示栈确实发生了改变，false 表示没有变化。
 */
export const reconcilePanelStackAtom = atom(
  null,
  (get, set, { entries, focusedIndex }: {
    entries: { route: ViewRoute; proportion: number }[]
    focusedIndex?: number
  }): boolean => {
    if (entries.length === 0) return false

    const current = get(panelStackAtom)
    const used = new Set<string>()

    const requestedFocusIndex = Math.min(focusedIndex ?? 0, entries.length - 1)
    const requestedFocusRoute = entries[requestedFocusIndex]?.route ?? entries[0].route

    const newStack = entries.map((target, i) => {
      const positional = current[i]

      // 优先复用同一位置且路由相同的面板
      if (positional && positional.route === target.route && !used.has(positional.id)) {
        used.add(positional.id)
        const updated = createEntry(target.route, target.proportion, positional.id)
        return { ...updated, proportion: target.proportion }
      }

      // 其次复用任何路由相同的面板
      const any = current.find(c => c.route === target.route && !used.has(c.id))
      if (any) {
        used.add(any.id)
        const updated = createEntry(target.route, target.proportion, any.id)
        return { ...updated, proportion: target.proportion }
      }

      // 再次复用同位置但路由不同的面板
      if (positional && !used.has(positional.id)) {
        used.add(positional.id)
        const updated = createEntry(target.route, target.proportion, positional.id)
        return { ...updated, proportion: target.proportion }
      }

      // 都没有则新建面板
      return createEntry(target.route, target.proportion)
    })

    const normalized = normalizeProportions(newStack)

    // 如果新栈和旧栈完全一致（ID、路由、通道、类型、比例都相同），
    // 只更新焦点，避免触发不必要的重渲染。
    if (
      normalized.length === current.length &&
      normalized.every((p, i) =>
        p.id === current[i].id &&
        p.route === current[i].route &&
        p.laneId === current[i].laneId &&
        p.panelType === current[i].panelType &&
        Math.abs(p.proportion - current[i].proportion) < 0.001
      )
    ) {
      const targetFocusId =
        normalized[Math.min(requestedFocusIndex, normalized.length - 1)]?.id ??
        normalized.find((p) => p.route === requestedFocusRoute)?.id ??
        null
      if (get(focusedPanelIdAtom) !== targetFocusId) {
        set(focusedPanelIdAtom, targetFocusId)
      }
      return false
    }

    set(panelStackAtom, normalized)

    const focusId =
      normalized[Math.min(requestedFocusIndex, normalized.length - 1)]?.id ??
      normalized.find((p) => p.route === requestedFocusRoute)?.id ??
      null
    set(focusedPanelIdAtom, focusId)

    return true
  }
)

/**
 * Action atom：调整两个相邻面板的宽度比例。
 * leftIndex/rightIndex 是面板在栈中的索引。
 */
export const resizePanelsAtom = atom(
  null,
  (get, set, { leftIndex, rightIndex, leftProportion, rightProportion }: {
    leftIndex: number
    rightIndex: number
    leftProportion: number
    rightProportion: number
  }) => {
    const stack = get(panelStackAtom)
    if (leftIndex < 0 || rightIndex >= stack.length) return
    const newStack = stack.map((p, i) => {
      if (i === leftIndex) return { ...p, proportion: leftProportion }
      if (i === rightIndex) return { ...p, proportion: rightProportion }
      return p
    })
    set(panelStackAtom, newStack)
  }
)

/**
 * Action atom：更新当前焦点面板的路由。
 * 如果栈为空，则新增一个占满宽度的面板。
 */
export const updateFocusedPanelRouteAtom = atom(
  null,
  (get, set, route: ViewRoute) => {
    const stack = get(panelStackAtom)

    if (stack.length === 0) {
      const newEntry = createEntry(route, 1)
      set(panelStackAtom, [newEntry])
      set(focusedPanelIdAtom, newEntry.id)
      return
    }

    const focusedId = get(focusedPanelIdAtom)
    const focused = stack.find(p => p.id === focusedId) ?? stack[0]

    const updated = stack.map((p) =>
      p.id === focused.id
        ? { ...createEntry(route, p.proportion, p.id), proportion: p.proportion }
        : p
    )

    set(panelStackAtom, updated)
    set(focusedPanelIdAtom, focused.id)
  }
)

/** Action atom：焦点切换到下一个面板（循环）。 */
export const focusNextPanelAtom = atom(
  null,
  (get, set) => {
    const stack = get(panelStackAtom)
    if (stack.length <= 1) return
    const currentIdx = get(focusedPanelIndexAtom)
    const nextIdx = (currentIdx + 1) % stack.length
    set(focusedPanelIdAtom, stack[nextIdx].id)
  }
)

/** Action atom：焦点切换到上一个面板（循环）。 */
export const focusPrevPanelAtom = atom(
  null,
  (get, set) => {
    const stack = get(panelStackAtom)
    if (stack.length <= 1) return
    const currentIdx = get(focusedPanelIndexAtom)
    const prevIdx = (currentIdx - 1 + stack.length) % stack.length
    set(focusedPanelIdAtom, stack[prevIdx].id)
  }
)
