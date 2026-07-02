/**
 * 浏览器面板状态原子
 *
 * 渲染进程中浏览器实例状态的 Jotai atoms。
 * 状态通过 BROWSER_PANE_STATE_CHANGED IPC 事件从主进程（main process）同步过来。
 *
 * Electron 主进程负责真正的浏览器窗口，渲染进程通过 IPC 接收状态并展示。
 * Jotai atom 是 React 生态里的细粒度状态单元。
 */

import { atom } from 'jotai'
import type { BrowserInstanceInfo } from '../../shared/types'

/** 按 ID 索引的所有浏览器实例。Map 类似 Go 的 map[string]BrowserInstanceInfo。 */
export const browserInstancesMapAtom = atom<Map<string, BrowserInstanceInfo>>(new Map())

/** 派生 atom：所有浏览器实例组成的数组（方便遍历）。 */
export const browserInstancesAtom = atom<BrowserInstanceInfo[]>(
  (get) => Array.from(get(browserInstancesMapAtom).values())
)

/** 派生 atom：当前活跃的浏览器实例数量。 */
export const browserInstanceCountAtom = atom<number>(
  (get) => get(browserInstancesMapAtom).size
)

/**
 * 根据工作区上下文过滤可见的浏览器实例。
 *
 * 远程连接的工作区在本地窗口里有两个相关的工作区 ID：
 *
 * - activeWorkspaceId — 本地 Craft Agents 窗口自身所属的工作区 ID，
 *   用于标记本地手动打开的浏览器标签页。
 * - remoteWorkspaceId — 同一概念工作区在远程服务器上的工作区 ID，
 *   远程 agent 通过 WS bridge 打开标签页时会使用这个 ID。
 *   可以从 activeWorkspace.remoteServer.remoteWorkspaceId 读取。
 *
 * 一个实例可见当且仅当：
 *   - workspaceId 为 null/undefined（未绑定，所有地方都可见），或
 *   - workspaceId 与本地工作区匹配，或
 *   - workspaceId 与远程镜像工作区匹配。
 *
 * 当两个上下文 ID 都为空（工作区尚未解析）时，直接返回不过滤的列表作为安全默认值。
 */
export function filterInstancesForWorkspace(
  all: BrowserInstanceInfo[],
  activeWorkspaceId: string | null,
  remoteWorkspaceId: string | null,
): BrowserInstanceInfo[] {
  if (!activeWorkspaceId && !remoteWorkspaceId) return all
  return all.filter(
    (i) =>
      !i.workspaceId ||
      i.workspaceId === activeWorkspaceId ||
      i.workspaceId === remoteWorkspaceId,
  )
}

/** 当前选中的浏览器实例 ID（用户交互选中的焦点）。 */
export const activeBrowserInstanceIdAtom = atom<string | null>(null)

/**
 * 已被移除的浏览器实例 ID 集合（墓碑）。
 * 用于防护迟到的乱序更新：实例已删除后，如果又收到该实例的旧状态更新，直接忽略。
 */
export const removedBrowserInstanceIdsAtom = atom<Set<string>>(new Set<string>())

/** 派生 atom：当前活跃浏览器实例的完整信息。 */
export const activeBrowserInstanceAtom = atom<BrowserInstanceInfo | null>((get) => {
  const activeId = get(activeBrowserInstanceIdAtom)
  if (!activeId) return null
  return get(browserInstancesMapAtom).get(activeId) ?? null
})

/**
 * Action atom：根据 IPC 状态变更事件更新单个浏览器实例。
 * 第一个参数写 null 表示这是只写的 action atom，组件可以通过 set(updateBrowserInstanceAtom, info) 触发。
 */
export const updateBrowserInstanceAtom = atom(
  null,
  (get, set, info: BrowserInstanceInfo) => {
    const removedIds = get(removedBrowserInstanceIdsAtom)
    if (removedIds.has(info.id)) {
      return
    }

    const map = new Map(get(browserInstancesMapAtom))
    map.set(info.id, info)
    set(browserInstancesMapAtom, map)
  }
)

/** Action atom：删除一个浏览器实例（实例被销毁时调用）。 */
export const removeBrowserInstanceAtom = atom(
  null,
  (get, set, id: string) => {
    const map = new Map(get(browserInstancesMapAtom))
    map.delete(id)
    set(browserInstancesMapAtom, map)

    const removedIds = new Set(get(removedBrowserInstanceIdsAtom))
    removedIds.add(id)
    set(removedBrowserInstanceIdsAtom, removedIds)
  }
)

/** Action atom：一次性设置全部浏览器实例（来自列表查询结果）。 */
export const setBrowserInstancesAtom = atom(
  null,
  (get, set, instances: BrowserInstanceInfo[]) => {
    const map = new Map<string, BrowserInstanceInfo>()
    for (const info of instances) {
      map.set(info.id, info)
    }
    set(browserInstancesMapAtom, map)

    const removedIds = new Set(get(removedBrowserInstanceIdsAtom))
    for (const info of instances) {
      removedIds.delete(info.id)
    }
    set(removedBrowserInstanceIdsAtom, removedIds)
  }
)
