/**
 * NavigationContext
 *
 * 提供一个全局的 navigate() 函数，让各个组件不需要直接依赖 session/action 相关的导入。
 * 所有导航都通过类型化的 route 对象完成。
 *
 * 对等面板模型（Peer Panel Model）：
 * 所有面板地位相等。当前“焦点”面板决定 NavigationState
 *（它会影响侧边栏高亮、导航器内容等）。
 * 调用 navigate(route) 会更新焦点面板的路由。
 *
 * URL 驱动历史：
 * URL 是唯一数据源。每次有意义的导航都会通过 pushState 写入浏览器历史。
 * 前进/回退使用浏览器原生的 popstate 事件，并通过智能面板协调保留 React key
 *（从而保留滚动位置、流式状态等）。
 *
 * 用法示例：
 *   import { useNavigation, useNavigationState } from '@/contexts/NavigationContext'
 *   import { routes } from '@/shared/routes'
 *
 *   const { navigate } = useNavigation()
 *   const navState = useNavigationState()
 *
 *   navigate(routes.view.allSessions())
 *   navigate(routes.action.newChat())
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useSession } from '@/hooks/useSession'
import { useLabels } from '@/hooks/useLabels'
import { matchesLabelFilter } from '@craft-agent/shared/labels'
import {
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
  buildRightSidebarParam,
  type ParsedRoute,
} from '../../shared/route-parser'
import { routes, type Route, type ViewRoute } from '../../shared/routes'
import { parsePermissionMode } from '@craft-agent/shared/agent/mode-types'
import { NAVIGATE_EVENT, type NavigateOptions } from '../lib/navigate'
import { normalizePanelRouteForReconcile } from './navigation-reconcile'
import { buildSemanticHistoryKey, canRunInitialRestore } from './navigation-history'
import * as storage from '@/lib/local-storage'
import type {
  DeepLinkNavigation,
  Session,
  NavigationState,
  SessionFilter,
  SourceFilter,
  RightSidebarPanel,
  ContentBadge,
} from '../../shared/types'
import {
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  isProjectsNavigation,
  DEFAULT_NAVIGATION_STATE,
} from '../../shared/types'
import { sessionMetaMapAtom, updateSessionMetaAtom, type SessionMeta } from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import {
  panelStackAtom,
  pushPanelAtom,
  reconcilePanelStackAtom,
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  focusedPanelIndexAtom,
  updateFocusedPanelRouteAtom,
  parseSessionIdFromRoute,
} from '@/atoms/panel-stack'

// 为了使用方便，再次导出 routes 和 Route 类型
export { routes }
export type { Route }

// 再次导出导航状态相关类型和守卫函数，方便上层组件直接使用
export type { NavigationState, SessionFilter }
export { isSessionsNavigation, isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation }

// =============================================================================
// Context（React Context：相当于一个依赖注入容器，子孙组件通过 useContext 读取）
// =============================================================================

// NavigationContext 对外暴露的值结构
interface NavigationContextValue {
  /** 导航到某个路由 */
  navigate: (route: Route, options?: NavigateOptions) => void | Promise<void>
  /** 导航是否已就绪 */
  isReady: boolean
  /** 统一的导航状态：由焦点面板 + 右侧边栏推导而来 */
  navigationState: NavigationState
  /** 是否能后退 */
  canGoBack: boolean
  /** 是否能前进 */
  canGoForward: boolean
  /** 后退 */
  goBack: () => void
  /** 前进 */
  goForward: () => void
  /** 更新右侧边栏面板 */
  updateRightSidebar: (panel: RightSidebarPanel | undefined) => void
  /** 切换右侧边栏（可传入指定面板） */
  toggleRightSidebar: (panel?: RightSidebarPanel) => void
  /** 导航到某个 source（或 source 列表），保留当前筛选类型 */
  navigateToSource: (sourceSlug?: string) => void
  /** 导航到某个 session，保留当前筛选类型 */
  navigateToSession: (sessionId: string) => void
}

// 创建 Context，初始值为 null；Provider 里再填入实际对象
export const NavigationContext = createContext<NavigationContextValue | null>(null)

// NavigationProvider 接收的 props
interface NavigationProviderProps {
  children: ReactNode
  /** 当前 workspace ID */
  workspaceId: string | null
  /** 当前 workspace slug（用于 URL 的 ?ws= 参数和 localStorage） */
  workspaceSlug: string | null
  /** 按 slug 切换 workspace（popstate 导致 ?ws= 变化时调用） */
  onSwitchWorkspaceBySlug?: (slug: string) => void
  /** 创建 session 的回调 */
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  /** 用于预填聊天输入框的回调 */
  onInputChange?: (sessionId: string, value: string) => void
  /** 读取某 session 的草稿输入（从 ref 读取，不触发重渲染） */
  getDraft?: (sessionId: string) => string
  /** 自动删除空 session（无需确认） */
  onAutoDeleteEmptySession?: (sessionId: string) => void
  /** 应用是否已准备好导航 */
  isReady?: boolean
  /** session 元数据是否已初始化（初始路由恢复需要它才能确定性地执行） */
  isSessionsReady?: boolean
  /** 远程 workspace ID：若设置，则该 ID 下的 session 也被视为当前 workspace 的一部分 */
  remoteWorkspaceId?: string | null
}

/**
 * NavigationProvider：为应用提供统一的导航状态与 navigate API。
 * 负责管理浏览器历史、URL 同步、面板栈协调、workspace 切换恢复、自动选择等。
 */
export function NavigationProvider({
  children,
  workspaceId,
  workspaceSlug,
  onSwitchWorkspaceBySlug,
  onCreateSession,
  onInputChange,
  getDraft,
  onAutoDeleteEmptySession,
  isReady = true,
  isSessionsReady = true,
  remoteWorkspaceId,
}: NavigationProviderProps) {
  const { t } = useTranslation()
  const [, setSession] = useSession()

  // 直接从 Jotai atom 读取 session 元数据（响应式，数据变化会自动重渲染）
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)
  // Label tree for filter matching (auto-select must agree with the visible list).
  const { labels: labelConfigs } = useLabels(workspaceId)

  const pushPanel = useSetAtom(pushPanelAtom)

  // useStore 返回 Jotai 的 store 实例；在回调里用 store.get() 可以读到最新值，
  // 避免闭包捕获旧值（类似 Go 里通过指针/全局 store 取最新状态）。
  const store = useStore()

  // 从 atom 读取 source 列表（由 AppShell 填充）
  const sources = useAtomValue(sourcesAtom)

  // 从 atom 读取 skill 列表（由 AppShell 填充）
  const skills = useAtomValue(skillsAtom)

  // =========================================================================
  // 派生导航状态（由焦点面板 + 右侧边栏计算得出）
  // =========================================================================

  const focusedRoute = useAtomValue(focusedPanelRouteAtom)

  // 右侧边栏独立于面板（不是每个面板各自一份状态）
  const [rightSidebar, setRightSidebar] = useState<RightSidebarPanel | undefined>()
  const rightSidebarRef = useRef<RightSidebarPanel | undefined>(rightSidebar)
  useEffect(() => { rightSidebarRef.current = rightSidebar }, [rightSidebar])

  // 根据焦点面板路由计算 NavigationState；如果右侧边栏打开，再合并进去
  const navigationState: NavigationState = useMemo(() => {
    const base = focusedRoute
      ? parseRouteToNavigationState(focusedRoute) ?? DEFAULT_NAVIGATION_STATE
      : DEFAULT_NAVIGATION_STATE
    return rightSidebar ? { ...base, rightSidebar } : base
  }, [focusedRoute, rightSidebar])

  // =========================================================================
  // 浏览器历史记录追踪
  // =========================================================================

  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  // 这些序号保存在 history.state 中，用来追踪当前在历史栈里的位置
  const historySeqRef = useRef(0)                // 当前 history 位置
  const historyMaxSeqRef = useRef(0)              // 已 push 的最大 seq（用于判断 canGoForward）
  const nextHistorySeqRef = useRef(1)             // 下次 pushState 要分配的 seq

  // 在恢复/协调过程中，暂停 atom 订阅里触发的 pushState
  const suppressPushRef = useRef(false)

  // 把一次复合 atom 写入（例如 pushPanelAtom 同时改 panelStackAtom 和 focusedPanelIdAtom）
  // 合并成一次 pushState；用 microtask 做防抖。
  const pendingPushRef = useRef(false)

  // 标记：workspace 切换是由 popstate 触发的（此时 URL 已经正确，不需要再 push）
  const isPopstateSwitchRef = useRef(false)

  // 如果应用还没就绪，先把导航请求暂存起来
  const pendingNavigationRef = useRef<ParsedRoute | null>(null)

  // 跳过一次自动选择；用于 skipAutoSelect，防止 effect 又把它重新选回来
  const suppressAutoSelectRef = useRef(false)

  // 记录是否已经尝试过初始路由恢复
  const initialRouteRestoredRef = useRef(false)

  // 上一次我们主动 push/reconcile 的历史条目的语义键。
  // 不包含 layout 相关值（如面板比例），避免调整大小时产生历史记录。
  const lastSemanticHistoryKeyRef = useRef('')

  /** 根据当前 history 序号更新“能否后退/前进”状态 */
  const updateCanGoBackForward = useCallback(() => {
    setCanGoBack(historySeqRef.current > 0)
    setCanGoForward(historySeqRef.current < historyMaxSeqRef.current)
  }, [])

  /** 根据当前面板栈、焦点面板、右侧边栏生成语义化历史键，用于去重 */
  const getSemanticHistoryKey = useCallback(() => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    const sidebarKey = buildRightSidebarParam(rightSidebarRef.current) ?? ''
    return buildSemanticHistoryKey({
      workspaceSlug,
      panelRoutes: panels.map(p => p.route),
      focusedPanelIndex: focusedIdx,
      sidebarParam: sidebarKey,
    })
  }, [store, workspaceSlug])

  // =========================================================================
  // URL 同步：根据当前状态构建 URL，并选择 push 或 replace
  // =========================================================================

  /**
   * 根据 atom 状态构建当前 URL，并决定是 push 新历史条目还是 replace 当前条目。
   *
   * push=true：创建新的浏览器历史条目（有意义的导航）。
   * push=false：更新当前历史条目（调整大小、自动选择等）。
   *
   * 同时会把每个 workspace 的 URL 持久化到 localStorage，用于 workspace 切换恢复。
   */
  const syncUrl = useCallback((push: boolean = false) => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    if (panels.length === 0) return

    const focusedPanel = panels[focusedIdx] ?? panels[0]
    const url = new URL(window.location.href)

    // ?ws= workspace slug
    if (workspaceSlug) {
      url.searchParams.set('ws', workspaceSlug)
    }

    // ?route= 当前焦点面板的路由
    url.searchParams.set('route', focusedPanel.route)

    // ?panels= 按顺序编码所有面板
    if (panels.length > 1) {
      const encoded = panels.map(p => `${p.route}:${p.proportion.toFixed(4)}`).join(',')
      url.searchParams.set('panels', encoded)
    } else {
      url.searchParams.delete('panels')
    }

    // ?fi= 焦点面板索引（多面板布局时使用）
    if (panels.length > 1) {
      url.searchParams.set('fi', String(focusedIdx))
    } else {
      url.searchParams.delete('fi')
    }

    // ?sidebar= 右侧边栏
    const sidebarParam = buildRightSidebarParam(rightSidebarRef.current)
    if (sidebarParam) {
      url.searchParams.set('sidebar', sidebarParam)
    } else {
      url.searchParams.delete('sidebar')
    }

    const urlStr = url.toString()

    if (push) {
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', urlStr)
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq // 浏览器会丢弃 forward history
      updateCanGoBackForward()
    } else {
      history.replaceState({ ...history.state, seq: historySeqRef.current }, '', urlStr)
    }

    // 按 workspace 持久化 URL，用于 workspace 切换时恢复
    if (workspaceSlug) {
      storage.set(storage.KEYS.workspaceUrl, url.search, workspaceSlug)
    }
  }, [store, workspaceSlug, updateCanGoBackForward])

  // 用 ref 保存最新 syncUrl，避免 effect 闭包依赖引发的问题
  const syncUrlRef = useRef(syncUrl)
  useEffect(() => { syncUrlRef.current = syncUrl }, [syncUrl])

  /**
   * 当语义化历史键发生变化时，push 一条新的浏览器历史记录。
   * 如果当前状态与上一条历史记录语义相同，则跳过，避免产生重复 history 条目。
   */
  const maybePushHistoryForSemanticChange = useCallback(() => {
    const currentSemanticKey = getSemanticHistoryKey()
    if (currentSemanticKey === lastSemanticHistoryKeyRef.current) return

    syncUrlRef.current?.(true)
    lastSemanticHistoryKeyRef.current = currentSemanticKey
  }, [getSemanticHistoryKey])

  // 面板栈、焦点、右侧边栏变化时执行 replaceState（捕获调整大小等无关 push 的变化）
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  useEffect(() => {
    if (!initialRouteRestoredRef.current) return
    syncUrlRef.current(false)
  }, [panelStack, focusedPanelId, rightSidebar])

  // =========================================================================
  // Atom 订阅：触发 pushState（有意义的导航）
  // =========================================================================

  // 面板栈变化：新增/删除/路由变化时 push history（比例调整不触发）
  useEffect(() => {
    let prevRoutes = store.get(panelStackAtom).map(p => p.route)
    const unsub = store.sub(panelStackAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const currRoutes = store.get(panelStackAtom).map(p => p.route)
      if (currRoutes.length !== prevRoutes.length || !currRoutes.every((r, i) => r === prevRoutes[i])) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
      }
      prevRoutes = currRoutes
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // 焦点变化：当前活动面板改变时 push history
  useEffect(() => {
    let prevFocusId = store.get(focusedPanelIdAtom)
    const unsub = store.sub(focusedPanelIdAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const newFocusId = store.get(focusedPanelIdAtom)
      if (newFocusId !== prevFocusId) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
        prevFocusId = newFocusId
      }
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // 右侧边栏变化：push history
  const prevSidebarTypeRef = useRef(rightSidebar?.type)
  useEffect(() => {
    if (rightSidebar?.type === prevSidebarTypeRef.current) return
    prevSidebarTypeRef.current = rightSidebar?.type
    if (suppressPushRef.current) return
    if (!initialRouteRestoredRef.current) return
    maybePushHistoryForSemanticChange()
  }, [rightSidebar, maybePushHistoryForSemanticChange])

  // =========================================================================
  // 从 URL 参数协调面板
  // =========================================================================

  /**
   * 解析 URL 查询参数，并协调面板栈 + 右侧边栏。
   * 使用 reconcilePanelStackAtom 做智能匹配（保留 React key）。
   */
  const reconcileFromUrlParams = useCallback(
    (params: URLSearchParams) => {
      const initialRoute = params.get('route')
      const sidebarParam = params.get('sidebar') || undefined
      const panelsParam = params.get('panels')
      const focusedIndexParam = params.get('fi')

      // 恢复右侧边栏
      if (sidebarParam) {
        const parsed = parseRouteToNavigationState('allSessions', sidebarParam)
        if (parsed?.rightSidebar) {
          setRightSidebar(parsed.rightSidebar)
        } else {
          setRightSidebar(undefined)
        }
      } else {
        setRightSidebar(undefined)
      }

      // 解析 URL 中的面板条目
      let entries: { route: ViewRoute; proportion: number }[] = []
      let focusedIndex = 0

      if (panelsParam) {
        // 标准格式：?panels= 包含所有面板，?fi= 是焦点索引。
        // 不再支持旧版的混合 route/panels 格式。
        entries = panelsParam.split(',').filter(Boolean).map(entry => {
          const colonIdx = entry.lastIndexOf(':')
          if (colonIdx > 0) {
            const proportion = parseFloat(entry.slice(colonIdx + 1))
            if (!isNaN(proportion) && proportion > 0 && proportion < 1) {
              const rawRoute = entry.slice(0, colonIdx) as ViewRoute
              const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
              return { route, proportion }
            }
          }
          const rawRoute = entry as ViewRoute
          const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
          return { route, proportion: 0 }
        })

        const hasProportions = entries.some(e => e.proportion > 0)
        if (!hasProportions) {
          const equal = 1 / entries.length
          entries.forEach(e => { e.proportion = equal })
        } else {
          const total = entries.reduce((s, e) => s + e.proportion, 0)
          if (total > 0 && Math.abs(total - 1) > 0.001) {
            entries.forEach(e => { e.proportion = e.proportion / total })
          }
        }

        focusedIndex = focusedIndexParam != null ? (parseInt(focusedIndexParam, 10) || 0) : 0
      } else if (initialRoute) {
        // 单面板场景：从 ?route= 恢复
        const navState = parseRouteToNavigationState(initialRoute)
        if (navState) {
          const finalRoute = ('details' in navState && navState.details)
            ? (initialRoute as ViewRoute)
            : (buildRouteFromNavigationState(resolveAutoSelectionRef.current(navState)) as ViewRoute)
          entries = [{ route: finalRoute, proportion: 1 }]
        }
      }

      if (entries.length > 0) {
        store.set(reconcilePanelStackAtom, { entries, focusedIndex })
      }
    },
    [store]
  )

  // 用 ref 保持回调最新，供事件处理器/effect 使用，避免它们捕获旧闭包
  const reconcileFromUrlParamsRef = useRef(reconcileFromUrlParams)
  useEffect(() => { reconcileFromUrlParamsRef.current = reconcileFromUrlParams }, [reconcileFromUrlParams])

  // =========================================================================
  // 空 session 清理（响应式：覆盖 navigate、关闭标签页等场景）
  // =========================================================================

  // 追踪所有面板中可见的 session ID。当某个 session ID 消失时
  //（导航离开、关闭标签页、Cmd+W），检查它是否为空并自动删除。
  // 这是所有“离开导航”统一的清理路径。
  const prevVisibleSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const currentIds = new Set<string>()
    for (const entry of panelStack) {
      const sessionId = parseSessionIdFromRoute(entry.route)
      if (sessionId) currentIds.add(sessionId)
    }

    // 至少已经收集过一版 ID 后才检查（跳过首次渲染，避免初始化期间误删）
    if (onAutoDeleteEmptySession && prevVisibleSessionIdsRef.current.size > 0) {
      for (const prevId of prevVisibleSessionIdsRef.current) {
        if (!currentIds.has(prevId)) {
          const meta = store.get(sessionMetaMapAtom).get(prevId)
          const isEmpty = meta && !meta.lastFinalMessageId && !meta.name && !meta.isProcessing
          const hasDraft = getDraft?.(prevId)?.trim()
          if (isEmpty && !hasDraft) {
            onAutoDeleteEmptySession(prevId)
          }
        }
      }
    }

    prevVisibleSessionIdsRef.current = currentIds
  }, [panelStack, onAutoDeleteEmptySession, store, getDraft])

  // =========================================================================
  // Session 选中状态同步
  // =========================================================================

  // 让全局 session 选中状态与焦点面板保持一致
  useEffect(() => {
    if (isSessionsNavigation(navigationState) && navigationState.details) {
      setSession({ selected: navigationState.details.sessionId })
      if (workspaceId) {
        // 只有属于当前 workspace 的 session 才持久化（避免 workspace 切换时，
        // workspaceId 已变但 navigationState 仍反映旧 workspace 的焦点面板，造成跨 workspace 污染）
        const meta = store.get(sessionMetaMapAtom).get(navigationState.details.sessionId)
        if (meta && meta.workspaceId === workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, navigationState.details.sessionId, workspaceId)
        }
      }
    }
  }, [navigationState, setSession, workspaceId, store])

  // =========================================================================
  // 工具函数
  // =========================================================================

  /**
   * 根据 SessionFilter 过滤当前 workspace 可见的 session。
   * 始终排除 hidden session——它们不应出现在导航中。
   */
  const filterSessionsByFilter = useCallback(
    (filter: SessionFilter): SessionMeta[] => {
      // 先排除 hidden，并限定在当前 workspace
      const visibleSessions = sessionMetas.filter(
        s => !s.hidden && (!workspaceId || s.workspaceId === workspaceId)
      )

      return visibleSessions.filter((session) => {
        switch (filter.kind) {
          case 'allSessions':
            return session.isArchived !== true
          case 'flagged':
            return session.isFlagged === true && session.isArchived !== true
          case 'archived':
            return session.isArchived === true
          case 'state':
            return session.sessionStatus === filter.stateId && session.isArchived !== true
          case 'label': {
            if (session.isArchived === true) return false
            // Shared predicate — descendant-aware and project-scoped, matching
            // exactly what the session list renders (auto-select must agree).
            return matchesLabelFilter(session, filter, labelConfigs)
          }
          case 'view':
            if (session.isArchived === true) return false
            return true
          default:
            return false
        }
      })
    },
    [sessionMetas, workspaceId, labelConfigs]
  )

  /** 返回符合当前筛选条件的第一个 session ID，没有则返回 null */
  const getFirstSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      const filtered = filterSessionsByFilter(filter)
      return filtered[0]?.id ?? null
    },
    [filterSessionsByFilter]
  )

  /** 从 localStorage 读取上次选中的 session ID，若已不再可见则返回 null */
  const getLastSelectedSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      if (!workspaceId) return null
      const storedId = storage.get<string | null>(
        storage.KEYS.lastSelectedSessionId,
        null,
        workspaceId
      )
      if (!storedId) return null
      const filtered = filterSessionsByFilter(filter)
      return filtered.some(session => session.id === storedId) ? storedId : null
    },
    [workspaceId, filterSessionsByFilter]
  )

  /** 返回第一个可见 source 的 slug；如果指定了 source 类型，则只在该类型里找 */
  const getFirstSourceSlug = useCallback(
    (filter?: SourceFilter | null): string | null => {
      if (!filter) {
        return sources[0]?.config.slug ?? null
      }
      const filtered = sources.filter(s => s.config.type === filter.sourceType)
      return filtered[0]?.config.slug ?? null
    },
    [sources]
  )

  /** 返回第一个可见 skill 的 slug */
  const getFirstSkillSlug = useCallback(
    (): string | null => {
      return skills[0]?.slug ?? null
    },
    [skills]
  )

  // =========================================================================
  // 自动选择（纯计算，无副作用）
  // =========================================================================

  /**
   * 为 NavigationState 解析自动选择。
   * 当导航到一个没有明确 details 的过滤器时，自动选择第一个可用项。
   * 返回最终状态，不产生副作用。
   */
  const resolveAutoSelection = useCallback(
    (newState: NavigationState, options?: { skipAutoSelect?: boolean }): NavigationState => {
      let nextState = newState

      // 校验 session 是否存在于当前 workspace（支持本地或远程 ID）
      if (isSessionsNavigation(nextState) && nextState.details) {
        const freshMetaMap = store.get(sessionMetaMapAtom)
        const meta = freshMetaMap.get(nextState.details.sessionId)
        const matchesWorkspace = !workspaceId
          || meta?.workspaceId === workspaceId
          || (remoteWorkspaceId && meta?.workspaceId === remoteWorkspaceId)
        if (!meta || !matchesWorkspace) {
          nextState = { ...nextState, details: null }
        }
      }

      // Sessions：自动选择上次选中/第一个 session。
      // 看板视图没有针对单个 session 的详情，因此跳过自动选择——
      // 否则导航到看板时会立即解析成聊天路由。
      if (
        isSessionsNavigation(nextState) &&
        nextState.viewMode !== 'board' &&
        !nextState.details &&
        !options?.skipAutoSelect
      ) {
        const lastSelectedSessionId = getLastSelectedSessionId(nextState.filter)
        const fallbackSessionId = lastSelectedSessionId ?? getFirstSessionId(nextState.filter)
        if (fallbackSessionId) {
          return { ...nextState, details: { type: 'session', sessionId: fallbackSessionId } }
        }
        return nextState
      }

      // Sources：自动选择第一个 source
      if (isSourcesNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const firstSourceSlug = getFirstSourceSlug(nextState.filter)
        if (firstSourceSlug) {
          return { ...nextState, details: { type: 'source', sourceSlug: firstSourceSlug } }
        }
        return nextState
      }

      // Skills：自动选择第一个 skill
      if (isSkillsNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const firstSkillSlug = getFirstSkillSlug()
        if (firstSkillSlug) {
          return { ...nextState, details: { type: 'skill', skillSlug: firstSkillSlug } }
        }
        return nextState
      }

      return nextState
    },
    [store, workspaceId, remoteWorkspaceId, getLastSelectedSessionId, getFirstSessionId, getFirstSourceSlug, getFirstSkillSlug]
  )

  // 用 ref 保持 resolveAutoSelection 最新，供前面定义的 reconcileFromUrlParams 使用
  const resolveAutoSelectionRef = useRef(resolveAutoSelection)
  useEffect(() => { resolveAutoSelectionRef.current = resolveAutoSelection }, [resolveAutoSelection])

  // =========================================================================
  // Action 导航（side effects，如创建 session、发送消息等）
  // =========================================================================

  /**
   * 处理 action 类型的路由：执行有副作用的操作，例如创建 session、重命名、删除、OAuth 等。
   * 这些路由不会直接改变面板状态，而是调用 Electron preload 暴露的 API。
   */
  const handleActionNavigation = useCallback(
    async (parsed: ParsedRoute, options?: { newPanel?: boolean; targetLaneId?: 'main' }) => {
      if (!workspaceId) return

      switch (parsed.name) {
        case 'new-session': {
          const createOptions: import('../../shared/types').CreateSessionOptions = {}
          if (parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (parsedMode) {
              createOptions.permissionMode = parsedMode
            }
          }
          if (parsed.params.workdir) {
            createOptions.workingDirectory = parsed.params.workdir as 'user_default' | 'none' | string
          }
          if (parsed.params.model) {
            createOptions.model = parsed.params.model
          }
          if (parsed.params.systemPrompt) {
            createOptions.systemPromptPreset = parsed.params.systemPrompt as 'default' | 'mini' | string
          }
          if (parsed.params.status) {
            createOptions.sessionStatus = parsed.params.status
          }
          if (parsed.params.label) {
            createOptions.labels = [parsed.params.label]
          }
          if (parsed.params.project) {
            createOptions.projectId = parsed.params.project
          }
          const session = await onCreateSession(workspaceId, createOptions)

          if (parsed.params.name) {
            await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: parsed.params.name })
          }

          if (parsed.params.status) {
            updateSessionMeta(session.id, { sessionStatus: parsed.params.status })
          }
          if (parsed.params.label) {
            updateSessionMeta(session.id, { labels: [parsed.params.label] })
          }

          if (parsed.params.status) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setSessionStatus', state: parsed.params.status })
          }
          if (parsed.params.label) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setLabels', labels: [parsed.params.label] })
          }

          // 决定导航到哪个过滤器
          const filter: import('../../shared/types').SessionFilter =
            parsed.params.status ? { kind: 'state', stateId: parsed.params.status } :
            parsed.params.label ? { kind: 'label', labelId: parsed.params.label } :
            { kind: 'allSessions' }

          if (options?.newPanel) {
            // 在新面板中打开新 session；pushPanel 会自动聚焦它
            pushPanel({
              route: routes.view.allSessions(session.id) as ViewRoute,
              targetLaneId: options.targetLaneId,
              intent: 'explicit',
            })
          } else {
            // 在焦点面板中导航到新 session
            const newState: NavigationState = {
              navigator: 'sessions',
              filter,
              details: { type: 'session', sessionId: session.id },
            }
            const route = buildRouteFromNavigationState(newState) as ViewRoute
            store.set(updateFocusedPanelRouteAtom, route)
            // session 选中同步由上面的 effect 处理
          }

          // 从参数解析 badges
          let badges: ContentBadge[] | undefined
          if (parsed.params.badges) {
            try {
              badges = JSON.parse(parsed.params.badges) as ContentBadge[]
            } catch (e) {
              console.warn('[Navigation] Failed to parse badges param:', e)
            }
          }

          // 处理输入：要么直接发送，要么预填
          if (parsed.params.input) {
            const shouldSend = parsed.params.send === 'true'
            if (shouldSend) {
              setTimeout(() => {
                window.electronAPI.sendMessage(
                  session.id,
                  parsed.params.input!,
                  undefined,
                  undefined,
                  badges ? { badges } : undefined
                )
              }, 100)
            } else if (onInputChange) {
              setTimeout(() => {
                onInputChange(session.id, parsed.params.input!)
              }, 100)
            }
          }
          break
        }

        case 'rename-session':
          if (parsed.id && parsed.params.name) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'rename', name: parsed.params.name })
          }
          break

        case 'delete-session':
          if (parsed.id) {
            await window.electronAPI.deleteSession(parsed.id)
          }
          break

        case 'flag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'flag' })
          }
          break

        case 'unflag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'unflag' })
          }
          break

        case 'oauth':
          if (parsed.id) {
            await window.electronAPI.performOAuth({ sourceSlug: parsed.id })
          }
          break

        case 'delete-source':
          if (parsed.id) {
            await window.electronAPI.deleteSource(workspaceId, parsed.id)
          }
          break

        case 'set-mode':
          if (parsed.id && parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (!parsedMode) {
              console.warn('[Navigation] Invalid permission mode:', parsed.params.mode)
              break
            }
            await window.electronAPI.sessionCommand(
              parsed.id,
              { type: 'setPermissionMode', mode: parsedMode }
            )
          }
          break

        case 'copy':
          if (parsed.params.text) {
            await navigator.clipboard.writeText(parsed.params.text)
          }
          break

        default:
          console.warn('[Navigation] Unknown action:', parsed.name)
      }
    },
    [workspaceId, onCreateSession, onInputChange, pushPanel, store, updateSessionMeta]
  )

  // =========================================================================
  // 主 navigate 函数
  // =========================================================================

  /**
   * 主导航入口。
   *
   * 根据路由类型分别处理：
   * - action：执行副作用（创建 session 等）
   * - view：解析为 NavigationState，自动选择缺省项，并更新焦点面板路由
   *
   * 若应用尚未就绪，会把导航请求暂存，等就绪后自动执行。
   */
  const navigate = useCallback(
    async (route: Route, options?: NavigateOptions) => {
      // 普通导航时重置自动选择抑制
      if (!options?.skipAutoSelect) {
        suppressAutoSelectRef.current = false
      }

      const parsed = parseRoute(route)
      if (!parsed) {
        console.warn('[Navigation] Invalid route:', route)
        return
      }

      if (!isReady) {
        pendingNavigationRef.current = parsed
        return
      }

      // 处理 action 类型（有副作用）
      if (parsed.type === 'action') {
        await handleActionNavigation(parsed, options)
        return
      }

      // 对于 view 路由且要求 newPanel：使用 lane-aware 路由推入新面板。
      //
      // 关键区别：
      // - explicit（intent='explicit'）可指定目标 lane
      // - 隐式导航走 updateFocusedPanelRouteAtom，会应用 lock/fallback 逻辑
      // 这模拟了 VS Code 的“锁定组”行为。
      if (options?.newPanel) {
        pushPanel({
          route: route as ViewRoute,
          targetLaneId: options.targetLaneId,
          intent: 'explicit',
        })
        return
      }

      // 把路由解析成 NavigationState。
      // 例如纯 'settings' 会得到 subpage: null，在紧凑模式下展示 navigator-only 视图，
      // 桌面端则回退到 App 页面。我们故意不重定向到最后访问的子页面，
      // 否则会破坏紧凑模式的钻入式体验。
      const newNavState = parseRouteToNavigationState(route)

      // 如果调用方要求跳过自动选择，设置抑制标记
      if (options?.skipAutoSelect) {
        suppressAutoSelectRef.current = true
      }

      if (newNavState) {
        // 解析自动选择（纯函数，无副作用）
        const resolvedState = resolveAutoSelection(newNavState, options)
        const finalRoute = buildRouteFromNavigationState(resolvedState) as ViewRoute

        // 持久化最后选中的 session，方便下次访问时自动选择
        if (isSessionsNavigation(resolvedState) && resolvedState.details && workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, resolvedState.details.sessionId, workspaceId)
        }

        // 同步更新焦点面板路由；panelStack atom 订阅会检测到路由变化并调用 syncUrl(true)
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    },
    [isReady, handleActionNavigation, resolveAutoSelection, store, pushPanel, workspaceId]
  )

  // =========================================================================
  // 后退 / 前进（调用浏览器 history API）
  // =========================================================================

  /** 调用浏览器 history.back() 后退一条记录 */
  const goBack = useCallback(() => {
    history.back()
  }, [])

  /** 调用浏览器 history.forward() 前进一条记录 */
  const goForward = useCallback(() => {
    history.forward()
  }, [])

  // =========================================================================
  // popstate 处理器（浏览器前进/后退）
  // =========================================================================

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      // 更新 history 序号追踪
      const eventSeq = event.state?.seq ?? 0
      historySeqRef.current = eventSeq
      updateCanGoBackForward()

      // 从 URL 读取状态（浏览器已经导航到目标 URL）
      const params = new URLSearchParams(window.location.search)
      const wsSlug = params.get('ws')

      // 检查 workspace 是否变化
      if (wsSlug && wsSlug !== workspaceSlug && onSwitchWorkspaceBySlug) {
        // 跨 workspace 边界：触发 workspace 切换
        // workspace 切换 effect 会负责后续协调
        isPopstateSwitchRef.current = true
        onSwitchWorkspaceBySlug(wsSlug)
        return
      }

      if (!isSessionsReady) {
        // session 元数据尚未初始化；初始恢复逻辑会在元数据可用后按当前 URL 协调
        return
      }

      // 同一 workspace：从 URL 协调面板
      suppressPushRef.current = true
      reconcileFromUrlParamsRef.current(params)
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
      requestAnimationFrame(() => {
        suppressPushRef.current = false
      })
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [workspaceSlug, onSwitchWorkspaceBySlug, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady])

  // =========================================================================
  // Workspace 切换
  // =========================================================================

  const previousWorkspaceSlugRef = useRef<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !workspaceSlug || !isSessionsReady) return

    if (previousWorkspaceSlugRef.current === null) {
      // 首次挂载：由初始路由恢复逻辑处理
      previousWorkspaceSlugRef.current = workspaceSlug
      return
    }

    if (previousWorkspaceSlugRef.current === workspaceSlug) return
    previousWorkspaceSlugRef.current = workspaceSlug

    // 协调期间暂停 pushState
    suppressPushRef.current = true

    if (isPopstateSwitchRef.current) {
      // 由 popstate 触发：URL 已经正确，直接协调
      isPopstateSwitchRef.current = false
      reconcileFromUrlParamsRef.current(new URLSearchParams(window.location.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    } else {
      // 由 UI 触发：加载新 workspace 保存的 URL，并 push 一条历史记录
      const savedSearch = storage.get<string>(storage.KEYS.workspaceUrl, '', workspaceSlug)

      const url = new URL(window.location.href)
      if (savedSearch) {
        // 用保存的 workspace URL 替换所有参数
        url.search = savedSearch
      } else {
        // 没有保存状态：默认进入 allSessions
        for (const key of [...url.searchParams.keys()]) {
          url.searchParams.delete(key)
        }
        url.searchParams.set('ws', workspaceSlug)
        url.searchParams.set('route', 'allSessions')
      }

      // 为 workspace 切换 push 一条新历史记录
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', url.toString())
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq
      updateCanGoBackForward()

      // 从新 URL 协调面板
      reconcileFromUrlParamsRef.current(new URLSearchParams(url.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    }

    initialRouteRestoredRef.current = true

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [workspaceId, workspaceSlug, store, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady])

  // =========================================================================
  // 初始路由恢复（Cmd+R 刷新后）
  // =========================================================================

  useEffect(() => {
    if (!canRunInitialRestore({
      isReady,
      isSessionsReady,
      workspaceId,
      initialRouteRestored: initialRouteRestoredRef.current,
    })) return
    initialRouteRestoredRef.current = true

    // 初始恢复期间暂停 pushState
    suppressPushRef.current = true

    const params = new URLSearchParams(window.location.search)

    // 从当前 URL 协调面板 + 右侧边栏
    reconcileFromUrlParamsRef.current(params)
    lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()

    // URL 为空则进入默认路由
    if (!params.get('route') && !params.get('panels')) {
      navigate(routes.view.allSessions())
    }

    // 用 seq=0 初始化 history（用 replaceState，避免多一条历史记录）
    history.replaceState({ seq: 0 }, '', window.location.href)
    historySeqRef.current = 0
    historyMaxSeqRef.current = 0

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [isReady, isSessionsReady, workspaceId, navigate, store, getSemanticHistoryKey])

  // =========================================================================
  // 挂起的导航
  // =========================================================================

  useEffect(() => {
    if (isReady && pendingNavigationRef.current) {
      const pending = pendingNavigationRef.current
      pendingNavigationRef.current = null

      if (pending.type === 'action') {
        handleActionNavigation(pending)
        return
      }

      const routeStr = `${pending.name}${pending.id ? `/${pending.id}` : ''}`
      const navState = parseRouteToNavigationState(routeStr)
      if (navState) {
        const resolved = resolveAutoSelection(navState)
        const finalRoute = buildRouteFromNavigationState(resolved) as ViewRoute
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    }
  }, [isReady, handleActionNavigation, resolveAutoSelection, store])

  // =========================================================================
  // Deep Link 监听（外部协议/系统打开应用时触发）
  // =========================================================================

  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onDeepLinkNavigate((nav: DeepLinkNavigation) => {
      let route: string | null = null

      if (nav.view) {
        route = nav.view
      } else if (nav.action) {
        route = `action/${nav.action}`
        if (nav.actionParams?.id) {
          route += `/${nav.actionParams.id}`
        }
        const otherParams = { ...nav.actionParams }
        delete otherParams.id
        if (Object.keys(otherParams).length > 0) {
          const params = new URLSearchParams(otherParams)
          route += `?${params.toString()}`
        }
      }

      if (route) {
        const navState = parseRouteToNavigationState(route)
        if (!navState && !route.startsWith('action/')) {
          toast.error(t('toast.invalidLink'), {
            description: t('toast.invalidLinkDesc'),
          })
          return
        }
        navigate(route as Route)
      }
    })

    return cleanup
  }, [workspaceId, navigate])

  // =========================================================================
  // 内部导航事件监听（组件间通过自定义事件触发导航）
  // =========================================================================

  useEffect(() => {
    const handleNavigateEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ route: Route; newPanel?: boolean; targetLaneId?: 'main' }>
      if (customEvent.detail?.route) {
        const { route: r, newPanel, targetLaneId } = customEvent.detail
        navigate(r, newPanel ? { newPanel, targetLaneId } : undefined)
      }
    }

    window.addEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    }
  }, [navigate])

  // =========================================================================
  // 右侧边栏辅助函数
  // =========================================================================

  /** 设置右侧边栏面板；对应的 pushState 由右侧边栏变化的 effect 负责 */
  const updateRightSidebar = useCallback((panel: RightSidebarPanel | undefined) => {
    setRightSidebar(panel)
    // pushState 由右侧边栏变化的 effect 处理
  }, [])

  /**
   * 切换右侧边栏。
   * 如果传入了指定面板则打开它，否则关闭当前侧边栏。
   */
  const toggleRightSidebar = useCallback((panel?: RightSidebarPanel) => {
    const currentSidebar = rightSidebarRef.current
    const newPanel = panel || (currentSidebar && currentSidebar.type !== 'none'
      ? { type: 'none' as const }
      : { type: 'none' as const })
    updateRightSidebar(newPanel)
  }, [updateRightSidebar])

  // =========================================================================
  // 保留筛选条件的导航辅助函数
  // =========================================================================

  /**
   * 导航到某个 source（或 source 列表），并尽量保留当前的 source 筛选类型。
   * 如果当前不在 source 导航下，则使用默认的 sources 路由。
   */
  const navigateToSource = useCallback((sourceSlug?: string) => {
    if (isSourcesNavigation(navigationState) && navigationState.filter?.kind === 'type') {
      switch (navigationState.filter.sourceType) {
        case 'api':
          navigate(routes.view.sourcesApi(sourceSlug))
          return
        case 'mcp':
          navigate(routes.view.sourcesMcp(sourceSlug))
          return
        case 'local':
          navigate(routes.view.sourcesLocal(sourceSlug))
          return
      }
    }
    navigate(routes.view.sources(sourceSlug ? { sourceSlug } : undefined))
  }, [navigationState, navigate])

  /**
   * 导航到某个 session，并尽量保留当前的 session 筛选条件（全部/标记/归档/状态/标签/视图）。
   * 如果当前不在 session 导航下，则回退到 allSessions。
   */
  const navigateToSession = useCallback((sessionId: string) => {
    if (!isSessionsNavigation(navigationState)) {
      navigate(routes.view.allSessions(sessionId))
      return
    }

    const filter = navigationState.filter
    switch (filter.kind) {
      case 'allSessions':
        navigate(routes.view.allSessions(sessionId))
        break
      case 'flagged':
        navigate(routes.view.flagged(sessionId))
        break
      case 'archived':
        navigate(routes.view.archived(sessionId))
        break
      case 'state':
        navigate(routes.view.state(filter.stateId, sessionId))
        break
      case 'label':
        navigate(routes.view.label(filter.labelId, sessionId))
        break
      case 'view':
        navigate(routes.view.view(filter.viewId, sessionId))
        break
      default:
        navigate(routes.view.allSessions(sessionId))
    }
  }, [navigationState, navigate])

  // =========================================================================
  // Session 加载后自动选择
  // =========================================================================

  useEffect(() => {
    if (suppressAutoSelectRef.current) return
    if (!isReady || !workspaceId) return
    // 如果面板栈为空（用户关闭了所有面板），不自动选择
    if (store.get(panelStackAtom).length === 0) return
    // Scoped to sessions with no explicit detail. resolveAutoSelection owns the
    // selection decision (board skip, last/first fallback) so it lives in one
    // place; this effect just applies it when the session list loads after
    // navigation (workspace switch, lazy session load, etc.).
    if (!isSessionsNavigation(navigationState) || navigationState.details) return

    const resolved = resolveAutoSelection(navigationState)
    if (isSessionsNavigation(resolved) && resolved.details) {
      navigateToSession(resolved.details.sessionId)
    }
  }, [
    isReady,
    workspaceId,
    navigationState,
    resolveAutoSelection,
    navigateToSession,
  ])

  // =========================================================================
  // Context value：把上面所有函数/状态注入给子孙组件
  // =========================================================================

  return (
    <NavigationContext.Provider
      value={{
        navigate,
        isReady,
        navigationState,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        updateRightSidebar,
        toggleRightSidebar,
        navigateToSource,
        navigateToSession,
      }}
    >
      {children}
    </NavigationContext.Provider>
  )
}

/**
 * Hook：获取导航相关函数
 */
export function useNavigation() {
  const context = useContext(NavigationContext)
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider')
  }
  return context
}

/**
 * Hook：仅获取导航状态
 */
export function useNavigationState(): NavigationState {
  const { navigationState } = useNavigation()
  return navigationState
}
