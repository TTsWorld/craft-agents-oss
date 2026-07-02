/**
 * SessionList — React 组件
 * 
 * 所属目录：app-shell
 */
import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useSetAtom } from "jotai"
import { isToday, isYesterday, format, startOfDay } from "date-fns"
import { getDateLocale } from "@craft-agent/shared/i18n"
import { useAction } from "@/actions"
import { Inbox, Archive } from "lucide-react"

import { getSessionStatus } from "@/utils/session"
import * as storage from "@/lib/local-storage"
import { KEYS } from "@/lib/local-storage"
import type { LabelConfig } from "@craft-agent/shared/labels"
import { flattenLabels } from "@craft-agent/shared/labels"
import * as MultiSelect from "@/hooks/useMultiSelect"
import { Spinner } from "@craft-agent/ui"
import { EntityListEmptyScreen } from "@/components/ui/entity-list-empty"
import { EntityList, type EntityListGroup } from "@/components/ui/entity-list"
import { RenameDialog } from "@/components/ui/rename-dialog"
import { SessionSearchHeader } from "./SessionSearchHeader"
import { SessionItem } from "./SessionItem"
import { SessionListProvider, type SessionListContextValue } from "@/context/SessionListContext"
import { useSessionSelection, useSessionSelectionStore } from "@/hooks/useSession"
import { useSessionSearch, type FilterMode } from "@/hooks/useSessionSearch"
import { useSessionActions } from "@/hooks/useSessionActions"
import { useEntityListInteractions } from "@/hooks/useEntityListInteractions"
import { useFocusZone } from "@/hooks/keyboard"
import { useEscapeInterrupt } from "@/context/EscapeInterruptContext"
import { useNavigation, useNavigationState, routes, isSessionsNavigation } from "@/contexts/NavigationContext"
import { useFocusContext } from "@/context/FocusContext"
import { sendToWorkspaceAtom, type SessionMeta } from "@/atoms/sessions"
import type { ViewConfig } from "@craft-agent/shared/views"
import type { SessionStatusId, SessionStatus } from "@/config/session-status-config"
import { buildCollapsedGroupsScopeSuffix } from "@/utils/session-list-collapse"

/**
 * SessionListRow：EntityList 内部使用的行数据类型。
 * 这里把 SessionMeta 包成对象，是为了和通用列表组件的数据结构保持一致。
 */
export interface SessionListRow {
  item: SessionMeta
}

/** 会话列表的分组方式：按日期 / 按状态 / 按未读 / 按项目 */
export type ChatGroupingMode = 'date' | 'status' | 'unread' | 'project'

interface SessionListProps {
  items: SessionMeta[]
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  onFlag?: (sessionId: string) => void
  onUnflag?: (sessionId: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onMarkUnread: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatusId) => void
  onRename: (sessionId: string, name: string) => void
  /** 按 Enter 时把焦点切到对应会话的聊天输入框 */
  onFocusChatInput?: (sessionId?: string) => void
  /** 选中某个会话时的回调 */
  onSessionSelect?: (session: SessionMeta) => void
  /** 用户想把会话在新窗口打开时的回调 */
  onOpenInNewWindow?: (session: SessionMeta) => void
  /** 切换到指定视图（如 allSessions / flagged）时的回调 */
  onNavigateToView?: (view: 'allSessions' | 'flagged') => void
  /** 每个会话的实时选项（运行时状态） */
  sessionOptions?: Map<string, import('../../hooks/useSessionOptions').SessionOptions>
  /** 是否处于搜索模式 */
  searchActive?: boolean
  /** 当前搜索关键字 */
  searchQuery?: string
  /** 搜索关键字变化时的回调 */
  onSearchChange?: (query: string) => void
  /** 关闭搜索时的回调 */
  onSearchClose?: () => void
  /** 工作区配置里的动态会话状态列表 */
  sessionStatuses?: SessionStatus[]
  /** 视图评估器：判断一个会话命中哪些视图配置 */
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  /** 标签配置，用于把会话的标签 ID 解析成展示信息 */
  labels?: LabelConfig[]
  /** 会话标签被切换时的回调（供 SessionMenu 的标签子菜单使用） */
  onLabelsChange?: (sessionId: string, labels: string[]) => void
  /** 工作区项目（供 SessionMenu 中的项目子菜单使用） */
  projects?: Array<{ id: string; slug: string; name: string; color?: string }>
  /** 绑定/解绑会话到项目的回调（null 表示解绑） */
  onSetProjectId?: (sessionId: string, projectId: string | null) => void
  /** 分组方式：默认按日期，也支持按状态/未读/项目 */
  groupingMode?: ChatGroupingMode
  /** 工作区 ID，用于内容搜索；不传则禁用内容搜索 */
  workspaceId?: string
  /** 二级状态筛选（“All Sessions” 里的状态芯片），影响搜索结果分组 */
  statusFilter?: Map<string, FilterMode>
  /** 二级标签筛选（标签芯片），影响搜索结果分组 */
  labelFilterMap?: Map<string, FilterMode>
  /** 覆盖当前高亮的会话（多面板场景下追踪焦点面板） */
  focusedSessionId?: string | null
  /** 覆盖导航目标：多面板时聚焦已有面板，或在焦点面板中导航 */
  onNavigateToSession?: (sessionId: string) => void
  /** 判断某会话是否有待处理的权限/管理员审批提示 */
  hasPendingPrompt?: (sessionId: string) => boolean
  /** 当前会话在 DOM 中实际命中的匹配信息（由 ChatDisplay 传入） */
  activeChatMatchInfo?: { sessionId: string | null; count: number; isHighlighting?: boolean }
}

// 把 SessionStatusId 重新导出，方便父组件直接使用
export type { SessionStatusId }

// 说明：今天/昨天单独走 i18n 翻译；其他日期用 date-fns 按语言格式化
function formatDateGroupLabel(date: Date, t: (key: string) => string, lang: string): string {
  if (isToday(date)) return t('common.today')
  if (isYesterday(date)) return t('common.yesterday')
  return format(date, 'MMM d', { locale: getDateLocale(lang) })
}

/**
 * SessionList：可滚动的会话卡片列表，支持键盘导航。
 *
 * 键盘快捷键：
 * - ↑/↓：导航并立即选中有焦点的会话
 * - ←/→：在焦点区域之间切换
 * - Enter：聚焦聊天输入框
 * - Home/End：跳到第一个/最后一个会话
 */
export function SessionList({
  items,
  onDelete,
  onFlag,
  onUnflag,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onSessionStatusChange,
  onRename,
  onFocusChatInput,
  onOpenInNewWindow,
  sessionOptions,
  searchActive,
  searchQuery = '',
  onSearchChange,
  onSearchClose,
  sessionStatuses = [],
  evaluateViews,
  labels = [],
  onLabelsChange,
  projects,
  onSetProjectId,
  groupingMode = 'date',
  workspaceId,
  statusFilter,
  labelFilterMap,
  focusedSessionId,
  onNavigateToSession,
  hasPendingPrompt,
  activeChatMatchInfo,
}: SessionListProps) {
  const { t, i18n } = useTranslation()
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)

  // --- 选择状态（由 atom 共享，ChatDisplay 和 BatchActionPanel 也会读写） ---
  const {
    select: selectSession,
    toggle: toggleSession,
    selectRange,
    isMultiSelectActive,
  } = useSessionSelection()
  const selectionStore = useSessionSelectionStore()

  const { navigate, navigateToSession: navigateToSessionPrimary } = useNavigation()
  const navigateToSession = onNavigateToSession ?? navigateToSessionPrimary
  const navState = useNavigationState()
  const { showEscapeOverlay } = useEscapeInterrupt()

  // 提前把标签树拍平一次，方便在每个 SessionItem 里快速按 ID 查找
  const flatLabels = useMemo(() => flattenLabels(labels), [labels])

  // 从导航状态拿到当前筛选条件，用于在标签路由之间保持上下文
  const currentFilter = isSessionsNavigation(navState) ? navState.filter : undefined

  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState("")
  // 记录搜索输入框是否真正拥有 DOM 焦点，用来正确控制键盘导航的生效条件
  const [isSearchInputFocused, setIsSearchInputFocused] = useState(false)

  // 可折叠分组的 key 集合；按工作区 / 筛选条件 / 分组方式做持久化，避免不同视图互相串
  const collapseScopeSuffix = useMemo(() => {
    return buildCollapsedGroupsScopeSuffix({
      workspaceId,
      currentFilter,
      groupingMode,
    })
  }, [
    workspaceId,
    groupingMode,
    currentFilter?.kind,
    currentFilter && 'stateId' in currentFilter ? currentFilter.stateId : undefined,
    currentFilter && 'labelId' in currentFilter ? currentFilter.labelId : undefined,
    currentFilter && 'viewId' in currentFilter ? currentFilter.viewId : undefined,
  ])

  // 读取指定 scope 下已折叠的分组；不存在时回退到旧版全局 key 做迁移
  const readCollapsedGroupsForScope = useCallback((scopeSuffix: string): Set<string> => {
    const scopedRaw = storage.getRaw(KEYS.collapsedSessionGroups, scopeSuffix)
    if (scopedRaw !== null) {
      try {
        const parsed = JSON.parse(scopedRaw)
        return new Set(Array.isArray(parsed) ? parsed : [])
      } catch {
        return new Set()
      }
    }

    // 兼容旧版本：早期没有 scope 后缀，使用单一全局 key。
    // 仅在当前 scope 从未写入过时作为迁移来源。
    const legacy = storage.get<string[]>(KEYS.collapsedSessionGroups, [])
    return new Set(legacy)
  }, [])

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedGroupsForScope(collapseScopeSuffix))
  const collapseScopeRef = useRef(collapseScopeSuffix)

  useEffect(() => {
    if (collapseScopeRef.current === collapseScopeSuffix) return
    setCollapsedGroups(readCollapsedGroupsForScope(collapseScopeSuffix))
    collapseScopeRef.current = collapseScopeSuffix
  }, [collapseScopeSuffix, readCollapsedGroupsForScope])

  useEffect(() => {
    // 切换上下文时，避免把上一个 scope 的旧数据写回本地存储
    if (collapseScopeRef.current !== collapseScopeSuffix) return
    storage.set(KEYS.collapsedSessionGroups, Array.from(collapsedGroups), collapseScopeSuffix)
  }, [collapsedGroups, collapseScopeSuffix])

  const toggleGroupCollapse = useCallback((groupKey: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }, [])

  // --- 数据处理流水线：搜索、筛选、分页、分组 ---
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  const {
    isSearchMode,
    highlightQuery,
    isSearchingContent,
    isSearchUnavailable,
    contentSearchResults,
    matchingFilterItems,
    otherResultItems,
    exceededSearchLimit,
    flatItems,
    hasMore,
    collapsedGroupsMeta,
    searchInputRef,
  } = useSessionSearch({
    items,
    searchActive: searchActive ?? false,
    searchQuery,
    workspaceId,
    currentFilter,
    evaluateViews,
    statusFilter,
    labelFilterMap,
    labelConfigs: labels,
    collapsedGroups,
    groupingMode,
    scrollViewportRef,
  })

  // 根据当前模式把 flatItems 加工成 EntityList 需要的行数据与分组结构
  const rowData = useMemo(() => {
    if (isSearchMode) {
      const matchingRows: SessionListRow[] = matchingFilterItems.map(item => ({ item }))
      const otherRows: SessionListRow[] = otherResultItems.map(item => ({ item }))

      const groups: EntityListGroup<SessionListRow>[] = []
      if (matchingRows.length > 0) {
        groups.push({ key: 'matching', label: t("session.inCurrentView"), items: matchingRows })
      }
      if (otherRows.length > 0) {
        groups.push({ key: 'other', label: t("session.otherConversations"), items: otherRows })
      }

      return {
        rows: [...matchingRows, ...otherRows],
        groups,
      }
    }

    // flatItems 只包含当前可见项（已展开 + 已分页）。
    // collapsedGroupsMeta 提供已折叠分组的 key 和数量，
    // 这样即使分组被折叠，我们也能在正确位置插入“仅标题”占位分组。
    const rows: SessionListRow[] = flatItems.map(item => ({ item }))

    if (groupingMode === 'unread') {
      // 固定两个桶：未读在上，已读在下；桶内保持 lastMessageAt 降序。
      // 即使某个桶为空也渲染标题，让用户一眼就知道当前模式；
      // 标题会显示数量，所以空桶也不会歧义（例如“未读 (0)”）。
      const unreadRows: SessionListRow[] = []
      const readRows: SessionListRow[] = []
      for (const row of rows) {
        if (row.item.hasUnread) unreadRows.push(row)
        else readRows.push(row)
      }
      unreadRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
      readRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))

      const collapsedUnread = collapsedGroupsMeta.find(m => m.key === 'unread-yes')
      const collapsedRead = collapsedGroupsMeta.find(m => m.key === 'unread-no')

      // 已折叠时优先用持久化里的数量（和日期/状态分组的处理方式一致）
      const unreadCount = collapsedUnread ? collapsedUnread.count : unreadRows.length
      const readCount = collapsedRead ? collapsedRead.count : readRows.length

      const orderedGroups: EntityListGroup<SessionListRow>[] = [
        {
          key: 'unread-yes',
          label: t('session.unreadGroup', { count: unreadCount }),
          items: unreadRows,
          // 空分组没有可折叠的内容，隐藏折叠箭头
          collapsible: unreadRows.length > 0 || !!collapsedUnread,
          ...(collapsedUnread ? { collapsedCount: collapsedUnread.count } : {}),
        },
        {
          key: 'unread-no',
          label: t('session.readGroup', { count: readCount }),
          items: readRows,
          collapsible: readRows.length > 0 || !!collapsedRead,
          ...(collapsedRead ? { collapsedCount: collapsedRead.count } : {}),
        },
      ]

      return {
        rows: orderedGroups.flatMap(g => g.items),
        groups: orderedGroups,
      }
    }

    if (groupingMode === 'status') {
      const statusOrder = new Map<string, number>()
      sessionStatuses.forEach((state, index) => statusOrder.set(state.id, index))

      // 按可见项的状态 ID 建分组
      const groupsByKey = new Map<string, { rows: SessionListRow[], statusId: string }>()
      for (const row of rows) {
        const statusId = getSessionStatus(row.item)
        const key = `status-${statusId}`
        if (!groupsByKey.has(key)) groupsByKey.set(key, { rows: [], statusId })
        groupsByKey.get(key)!.rows.push(row)
      }

      // 插入已折叠分组的占位项，保持顺序
      for (const meta of collapsedGroupsMeta) {
        if (!groupsByKey.has(meta.key)) {
          const statusId = meta.key.replace('status-', '')
          groupsByKey.set(meta.key, { rows: [], statusId })
        }
      }

      const orderedGroups: EntityListGroup<SessionListRow>[] = []
      for (const [key, { rows: groupRows, statusId }] of groupsByKey) {
        const state = sessionStatuses.find(s => s.id === statusId)
        if (!state) continue
        groupRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
        const collapsedMeta = collapsedGroupsMeta.find(m => m.key === key)
        orderedGroups.push({
          key,
          label: t(`status.${state.id}`, state.label),
          items: groupRows,
          collapsible: true,
          ...(collapsedMeta ? { collapsedCount: collapsedMeta.count } : {}),
        })
      }
      // 按工作区配置里的状态顺序排序
      orderedGroups.sort((a, b) => {
        const aOrder = statusOrder.get(a.key.replace('status-', '')) ?? 999
        const bOrder = statusOrder.get(b.key.replace('status-', '')) ?? 999
        return aOrder - bOrder
      })

      // 只有一个分组时没必要折叠
      if (orderedGroups.length === 1) {
        orderedGroups[0].collapsible = false
      }

      return {
        rows: orderedGroups.flatMap(g => g.items),
        groups: orderedGroups,
      }
    }

    if (groupingMode === 'project') {
      // 从可见项构建分组，按 projectId 分桶。
      // 没有 projectId（或 projectId 未知）的会话归入“无项目”桶，
      // 不会被静默丢弃。
      const projectOrder = new Map<string, number>()
      ;(projects ?? []).forEach((p, index) => projectOrder.set(p.id, index))
      const projectNameById = new Map<string, string>()
      ;(projects ?? []).forEach(p => projectNameById.set(p.id, p.name))

      const groupsByKey = new Map<string, { rows: SessionListRow[], projectId: string | null }>()
      for (const row of rows) {
        const rawProjectId = (row.item as { projectId?: string }).projectId
        const resolvedProjectId = rawProjectId && projectNameById.has(rawProjectId) ? rawProjectId : null
        const key = resolvedProjectId ? `project-${resolvedProjectId}` : 'project-__none__'
        if (!groupsByKey.has(key)) groupsByKey.set(key, { rows: [], projectId: resolvedProjectId })
        groupsByKey.get(key)!.rows.push(row)
      }

      // 插入已折叠分组的占位项（仅标题，items 为空）
      for (const meta of collapsedGroupsMeta) {
        if (!groupsByKey.has(meta.key)) {
          const idPart = meta.key.replace('project-', '')
          const projectId = idPart === '__none__' ? null : idPart
          groupsByKey.set(meta.key, { rows: [], projectId })
        }
      }

      const orderedGroups: EntityListGroup<SessionListRow>[] = []
      for (const [key, { rows: groupRows, projectId }] of groupsByKey) {
        groupRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
        const collapsedMeta = collapsedGroupsMeta.find(m => m.key === key)
        const label = projectId
          ? (projectNameById.get(projectId) ?? t('sidebar.unknownProject', { defaultValue: 'Unknown project' }))
          : t('sidebar.noProject', { defaultValue: 'No project' })
        orderedGroups.push({
          key,
          label,
          items: groupRows,
          collapsible: true,
          ...(collapsedMeta ? { collapsedCount: collapsedMeta.count } : {}),
        })
      }
      orderedGroups.sort((a, b) => {
        // 无项目桶沉到底部，已配置项目按注册顺序排列
        if (a.key === 'project-__none__') return 1
        if (b.key === 'project-__none__') return -1
        const aOrder = projectOrder.get(a.key.replace('project-', '')) ?? 999
        const bOrder = projectOrder.get(b.key.replace('project-', '')) ?? 999
        return aOrder - bOrder
      })

      if (orderedGroups.length === 1) {
        orderedGroups[0].collapsible = false
      }

      return {
        rows: orderedGroups.flatMap(g => g.items),
        groups: orderedGroups,
      }
    }

    // 默认：按日期分组
    const groupsByKey = new Map<string, EntityListGroup<SessionListRow>>()
    const groupDates = new Map<string, Date>()

    for (const row of rows) {
      const day = startOfDay(new Date(row.item.lastMessageAt || 0))
      const groupKey = day.toISOString()

      if (!groupsByKey.has(groupKey)) {
        groupsByKey.set(groupKey, {
          key: groupKey,
          label: formatDateGroupLabel(day, t, i18n.resolvedLanguage ?? 'en'),
          items: [],
          collapsible: true,
        })
        groupDates.set(groupKey, day)
      }
      groupsByKey.get(groupKey)!.items.push(row)
    }

    // 插入已折叠的日期占位分组（只渲染标题，items 为空）
    for (const meta of collapsedGroupsMeta) {
      if (!groupsByKey.has(meta.key)) {
        const date = new Date(meta.key)
        groupsByKey.set(meta.key, {
          key: meta.key,
          label: formatDateGroupLabel(date, t, i18n.resolvedLanguage ?? 'en'),
          items: [],
          collapsible: true,
          collapsedCount: meta.count,
        })
        groupDates.set(meta.key, date)
      }
    }

    // 所有日期分组按时间倒序排列
    const orderedKeys = Array.from(groupDates.entries())
      .sort(([, a], [, b]) => b.getTime() - a.getTime())
      .map(([key]) => key)

    const orderedGroups = orderedKeys.map(key => groupsByKey.get(key)!)

    // 只有一个分组时禁用折叠
    if (orderedGroups.length === 1) {
      orderedGroups[0].collapsible = false
    }

    return {
      rows,
      groups: orderedGroups,
    }
  }, [isSearchMode, matchingFilterItems, otherResultItems, flatItems, groupingMode, sessionStatuses, projects, collapsedGroupsMeta, t])

  const flatRows = rowData.rows

  const collapseAllGroups = useCallback(() => {
    if (groupingMode === 'status') {
      const allKeys = new Set(items.map(item => `status-${getSessionStatus(item)}`))
      setCollapsedGroups(allKeys)
    } else if (groupingMode === 'unread') {
      const allKeys = new Set(items.map(item => item.hasUnread ? 'unread-yes' : 'unread-no'))
      setCollapsedGroups(allKeys)
    } else if (groupingMode === 'project') {
      const knownProjectIds = new Set((projects ?? []).map(p => p.id))
      const allKeys = new Set(items.map(item => {
        const pid = (item as { projectId?: string }).projectId
        return pid && knownProjectIds.has(pid) ? `project-${pid}` : 'project-__none__'
      }))
      setCollapsedGroups(allKeys)
    } else {
      const allKeys = new Set(items.map(item =>
        startOfDay(new Date(item.lastMessageAt || 0)).toISOString()
      ))
      setCollapsedGroups(allKeys)
    }
  }, [items, groupingMode, projects])
  const expandAllGroups = useCallback(() => {
    setCollapsedGroups(new Set())
  }, [])

  // 建立会话 ID 到 flatRows 索引的映射，方便后续快速定位
  const rowIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatRows.forEach((row, index) => {
      map.set(row.item.id, index)
    })
    return map
  }, [flatRows])

  // --- 操作回调（内部会弹出 toast 提示） ---
  const {
    handleFlagWithToast,
    handleUnflagWithToast,
    handleArchiveWithToast,
    handleUnarchiveWithToast,
    handleDeleteWithToast,
  } = useSessionActions({ onFlag, onUnflag, onArchive, onUnarchive, onDelete })

  // --- 焦点区域 ---
  const { focusZone } = useFocusContext()
  const { zoneRef, isFocused, shouldMoveDOMFocus } = useFocusZone({ zoneId: 'navigator' })

  // 键盘导航生效条件：焦点在当前区域，或者搜索框被聚焦（用于方向键导航）
  const isKeyboardEligible = isFocused || (searchActive && isSearchInputFocused)

  // --- 交互逻辑：键盘导航 + 通过共享 atom 进行多选 ---
  const interactions = useEntityListInteractions<SessionListRow>({
    items: flatRows,
    getId: (row) => row.item.id,
    keyboard: {
      onNavigate: useCallback((row: SessionListRow) => {
        navigateToSession(row.item.id)
      }, [navigateToSession]),
      onActivate: useCallback((row: SessionListRow) => {
        // 多选模式下不导航，保持原有行为；只触发聚焦输入框
        if (!MultiSelect.isMultiSelectActive(selectionStore.state)) {
          navigateToSession(row.item.id)
        }
        onFocusChatInput?.(row.item.id)
      }, [selectionStore.state, navigateToSession, onFocusChatInput]),
      enabled: isKeyboardEligible,
      virtualFocus: searchActive ?? false,
    },
    multiSelect: true,
    selectionStore,
    selectedIdOverride: focusedSessionId,
  })

  // 外部修改选中项（如 ChatDisplay）时，同步当前活动索引
  useEffect(() => {
    const newIndex = flatRows.findIndex(row => row.item.id === selectionStore.state.selected)
    if (newIndex >= 0 && newIndex !== interactions.keyboard.activeIndex) {
      interactions.keyboard.setActiveIndex(newIndex)
    }
  }, [selectionStore.state.selected, flatRows, interactions.keyboard])

  // 当导航区域获得键盘焦点时，把 DOM 焦点移到当前活动项
  useEffect(() => {
    if (shouldMoveDOMFocus && flatRows.length > 0 && !(searchActive ?? false)) {
      interactions.keyboard.focusActiveItem()
    }
  }, [shouldMoveDOMFocus, flatRows.length, searchActive, interactions.keyboard])

  // --- 全局键盘快捷键 ---
  const isFocusWithinZone = () => zoneRef.current?.contains(document.activeElement) ?? false

  useAction('navigator.selectAll', () => {
    interactions.selection.selectAll()
  }, {
    enabled: isFocusWithinZone,
  }, [interactions.selection])

  useAction('navigator.clearSelection', () => {
    const selectedId = selectionStore.state.selected
    interactions.selection.clear()
    if (selectedId) navigateToSession(selectedId)
  }, {
    enabled: () => isMultiSelectActive && !showEscapeOverlay,
  }, [isMultiSelectActive, showEscapeOverlay, interactions.selection, selectionStore.state.selected, navigateToSession])

  // --- 鼠标点击处理 ---
  const handleSelectSession = useCallback((row: SessionListRow, index: number) => {
    selectSession(row.item.id, index)
    navigateToSession(row.item.id)
  }, [selectSession, navigateToSession])

  const handleSelectSessionById = useCallback((sessionId: string) => {
    const index = rowIndexMap.get(sessionId) ?? -1
    if (index >= 0) {
      selectSession(sessionId, index)
    } else {
      selectSession(sessionId, 0)
    }
    navigateToSession(sessionId)
  }, [rowIndexMap, selectSession, navigateToSession])

  const handleToggleSelect = useCallback((row: SessionListRow, index: number) => {
    focusZone('navigator', { intent: 'click', moveFocus: false })
    toggleSession(row.item.id, index)
  }, [focusZone, toggleSession])

  const handleRangeSelect = useCallback((toIndex: number) => {
    focusZone('navigator', { intent: 'click', moveFocus: false })
    const allIds = flatRows.map(row => row.item.id)
    selectRange(toIndex, allIds)
  }, [focusZone, flatRows, selectRange])

  // 方向键切换焦点区域：左 → 侧边栏，右 → 聊天区
  const handleKeyDown = useCallback((e: React.KeyboardEvent, _item: SessionMeta) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusZone('sidebar', { intent: 'keyboard' })
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusZone('chat', { intent: 'keyboard' })
      return
    }
  }, [focusZone])

  // --- 重命名弹窗 ---
  const handleRenameClick = useCallback((sessionId: string, currentName: string) => {
    setRenameSessionId(sessionId)
    setRenameName(currentName)
    requestAnimationFrame(() => {
      setRenameDialogOpen(true)
    })
  }, [])

  const handleRenameSubmit = () => {
    if (renameSessionId && renameName.trim()) {
      onRename(renameSessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
    setRenameSessionId(null)
    setRenameName("")
  }

  // --- 搜索框键盘处理 ---
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      searchInputRef.current?.blur()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onFocusChatInput?.(selectionStore.state.selected ?? undefined)
      return
    }
    // 把方向键事件转给交互层处理
    interactions.searchInputProps.onKeyDown(e)
  }, [searchInputRef, onFocusChatInput, interactions.searchInputProps, selectionStore.state.selected])

  // --- 上下文值（共享给所有 SessionItem） ---
  const handleFocusZone = useCallback(() => focusZone('navigator', { intent: 'click', moveFocus: false }), [focusZone])
  const handleOpenInNewWindow = useCallback((item: SessionMeta) => onOpenInNewWindow?.(item), [onOpenInNewWindow])
  const resolvedSearchQuery = isSearchMode ? highlightQuery : searchQuery

  const listContext = useMemo((): SessionListContextValue => ({
    onRenameClick: handleRenameClick,
    onSessionStatusChange,
    onFlag: onFlag ? handleFlagWithToast : undefined,
    onUnflag: onUnflag ? handleUnflagWithToast : undefined,
    onArchive: onArchive ? handleArchiveWithToast : undefined,
    onUnarchive: onUnarchive ? handleUnarchiveWithToast : undefined,
    onMarkUnread,
    onDelete: handleDeleteWithToast,
    onLabelsChange,
    projects,
    onSetProjectId,
    onSelectSessionById: handleSelectSessionById,
    onOpenInNewWindow: handleOpenInNewWindow,
    onSendToWorkspace: (ids: string[]) => setSendToWorkspace(ids),
    onFocusZone: handleFocusZone,
    onKeyDown: handleKeyDown,
    sessionStatuses,
    flatLabels,
    labels,
    searchQuery: resolvedSearchQuery,
    selectedSessionId: focusedSessionId !== undefined ? focusedSessionId : selectionStore.state.selected,
    isMultiSelectActive,
    sessionOptions,
    contentSearchResults,
    activeChatMatchInfo,
    hasPendingPrompt,
  }), [
    handleRenameClick, onSessionStatusChange,
    onFlag, handleFlagWithToast, onUnflag, handleUnflagWithToast,
    onArchive, handleArchiveWithToast, onUnarchive, handleUnarchiveWithToast,
    onMarkUnread, handleDeleteWithToast, onLabelsChange,
    projects, onSetProjectId,
    handleSelectSessionById, handleOpenInNewWindow, setSendToWorkspace, handleFocusZone, handleKeyDown,
    sessionStatuses, flatLabels, labels, resolvedSearchQuery,
    focusedSessionId, selectionStore.state.selected, isMultiSelectActive,
    sessionOptions, contentSearchResults, activeChatMatchInfo, hasPendingPrompt,
  ])

  // --- 空状态（非搜索模式）—— 在 EntityList 之前返回 ---
  // 如果有已折叠分组（即使当前没有展开项）也不显示空状态
  if (flatRows.length === 0 && rowData.groups.length === 0 && !searchActive) {
    if (currentFilter?.kind === 'archived') {
      return (
        <EntityListEmptyScreen
          icon={<Archive />}
          title={t("session.noArchivedSessions")}
          description={t("session.noArchivedSessionsDesc")}
          className="h-full"
        />
      )
    }

    return (
      <EntityListEmptyScreen
        icon={<Inbox />}
        title={t("session.noSessionsYet")}
        description={t("session.noSessionsYetDesc")}
        className="h-full"
      >
        <button
          onClick={() => {
            const params: { status?: string; label?: string } = {}
            if (currentFilter?.kind === 'state') params.status = currentFilter.stateId
            else if (currentFilter?.kind === 'label') params.label = currentFilter.labelId
            navigate(routes.action.newSession(Object.keys(params).length > 0 ? params : undefined))
          }}
          className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors"
        >
          {t("session.newSession")}
        </button>
      </EntityListEmptyScreen>
    )
  }

  // --- 渲染 ---
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <SessionListProvider value={listContext}>
      <EntityList<SessionListRow>
        groups={rowData.groups}
        getKey={(row) => row.item.id}
        renderItem={(row, _indexInGroup, isFirstInGroup) => {
          const flatIndex = rowIndexMap.get(row.item.id) ?? 0
          const rowProps = interactions.getRowProps(row, flatIndex)
          return (
            <SessionItem
              item={row.item}
              index={flatIndex}
              itemProps={rowProps.buttonProps as Record<string, unknown>}
              isSelected={rowProps.isSelected}
              isFirstInGroup={isFirstInGroup}
              isInMultiSelect={rowProps.isInMultiSelect ?? false}
              onSelect={() => handleSelectSession(row, flatIndex)}
              onToggleSelect={() => handleToggleSelect(row, flatIndex)}
              onRangeSelect={() => handleRangeSelect(flatIndex)}
            />
          )
        }}
        header={
          <>
            {searchActive && (
              <SessionSearchHeader
                searchQuery={searchQuery}
                onSearchChange={onSearchChange}
                onSearchClose={onSearchClose}
                onKeyDown={handleSearchKeyDown}
                onFocus={() => setIsSearchInputFocused(true)}
                onBlur={() => setIsSearchInputFocused(false)}
                isSearching={isSearchingContent}
                isUnavailable={isSearchUnavailable}
                resultCount={matchingFilterItems.length + otherResultItems.length}
                exceededLimit={exceededSearchLimit}
                inputRef={searchInputRef}
              />
            )}
            {isSearchMode && matchingFilterItems.length === 0 && otherResultItems.length > 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                {t("session.noResultsInFilter")}
              </div>
            )}
          </>
        }
        emptyState={
          isSearchMode && !isSearchingContent ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <p className="text-sm text-muted-foreground">{t("session.noSessionsFound")}</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                {t("session.noSessionsFoundDesc")}
              </p>
              <button
                onClick={() => onSearchChange?.('')}
                className="text-xs text-foreground hover:underline mt-2"
              >
                {t("session.clearSearch")}
              </button>
            </div>
          ) : undefined
        }
        footer={
          hasMore ? (
            <div className="flex justify-center py-4">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : undefined
        }
        viewportRef={scrollViewportRef}
        containerRef={zoneRef}
        containerProps={{
          'data-focus-zone': 'navigator',
          'data-list-role': 'sessions',
          role: 'listbox',
          'aria-label': 'Sessions',
        }}
        scrollAreaClassName="select-none mask-fade-top-short"
        collapsedGroups={collapsedGroups}
        onToggleCollapse={toggleGroupCollapse}
        onCollapseAll={collapseAllGroups}
        onExpandAll={expandAllGroups}
      />
      </SessionListProvider>

      {/* 重命名弹窗 */}
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t("session.renameSession")}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t("session.enterSessionName")}
      />
    </div>
  )
}
