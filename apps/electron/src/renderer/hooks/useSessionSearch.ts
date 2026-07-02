import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { isToday, isYesterday, format, startOfDay } from "date-fns"

import { searchLog } from "@/lib/logger"
import { parseLabelEntry, matchesLabelFilter } from "@craft-agent/shared/labels"
import type { LabelConfig } from "@craft-agent/shared/labels"
import { fuzzyScore } from "@craft-agent/shared/search"
import { getSessionTitle, getSessionStatus } from "@/utils/session"
import type { SessionMeta } from "@/atoms/sessions"
import type { ViewConfig } from "@craft-agent/shared/views"
import type { SessionFilter } from "@/contexts/NavigationContext"

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const INITIAL_DISPLAY_LIMIT = 50
const BATCH_SIZE = 50
const MAX_SEARCH_RESULTS = 100

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 三态过滤模式：include 只显示匹配项，exclude 隐藏匹配项 */
export type FilterMode = 'include' | 'exclude'

export interface DateGroup {
  date: Date
  label: string
  sessions: SessionMeta[]
}

export interface ContentSearchResult {
  matchCount: number
  snippet: string
}

/** 折叠分组元数据 —— 由数据管道输出，渲染层可据此展示仅含标题的分组 */
export interface CollapsedGroupMeta {
  key: string
  count: number
}

export interface UseSessionSearchOptions {
  items: SessionMeta[]
  searchActive: boolean
  searchQuery: string
  workspaceId?: string
  currentFilter?: SessionFilter
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, FilterMode>
  labelFilterMap?: Map<string, FilterMode>
  /** Workspace 标签树 —— 标签过滤器通过它匹配后代（共享的 matchesLabelFilter）。 */
  labelConfigs?: LabelConfig[]
  /** 折叠分组的 key —— 折叠项不参与分页和 flatItems */
  collapsedGroups?: Set<string>
  /** 分组模式 —— 折叠感知分页时需要用它计算分组 key */
  groupingMode?: 'date' | 'status' | 'unread' | 'project'
  /** ScrollArea 视口元素 ref —— 用于基于滚动的分页 */
  scrollViewportRef?: React.RefObject<HTMLDivElement>
}

export interface UseSessionSearchResult {
  // 搜索状态
  isSearchMode: boolean
  highlightQuery: string | undefined
  isSearchingContent: boolean
  /** 搜索服务是否不可用（例如远程服务器未安装 ripgrep） */
  isSearchUnavailable: boolean
  /** 原始内容搜索结果 —— SessionItem 需要它显示 chatMatchCount */
  contentSearchResults: Map<string, ContentSearchResult>

  // 过滤 + 分组后的结果
  matchingFilterItems: SessionMeta[]
  otherResultItems: SessionMeta[]
  exceededSearchLimit: boolean

  // 可直接渲染的输出
  flatItems: SessionMeta[]
  dateGroups: DateGroup[]
  sessionIndexMap: Map<string, number>

  // 分页
  hasMore: boolean
  /** 折叠分组元数据（key + 数量）—— 用于构建仅标题的占位分组 */
  collapsedGroupsMeta: CollapsedGroupMeta[]

  // Refs
  searchInputRef: React.RefObject<HTMLInputElement>
}

// ---------------------------------------------------------------------------
// 纯辅助函数（从 SessionList 移入）
// ---------------------------------------------------------------------------

function formatDateHeader(date: Date): string {
  if (isToday(date)) return "Today"
  if (isYesterday(date)) return "Yesterday"
  return format(date, "MMM d")
}

function groupSessionsByDate(sessions: SessionMeta[]): DateGroup[] {
  const groups = new Map<string, { date: Date; sessions: SessionMeta[] }>()

  for (const session of sessions) {
    const timestamp = session.lastMessageAt || 0
    const date = startOfDay(new Date(timestamp))
    const key = date.toISOString()

    if (!groups.has(key)) {
      groups.set(key, { date, sessions: [] })
    }
    groups.get(key)!.sessions.push(session)
  }

  return Array.from(groups.values())
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map(group => ({
      ...group,
      label: formatDateHeader(group.date),
    }))
}

function getCollapseGroupKey(item: SessionMeta, groupingMode?: 'date' | 'status' | 'unread' | 'project'): string {
  if (groupingMode === 'status') return `status-${getSessionStatus(item)}`
  if (groupingMode === 'unread') return item.hasUnread ? 'unread-yes' : 'unread-no'
  if (groupingMode === 'project') return `project-${(item as { projectId?: string }).projectId ?? '__none__'}`
  return startOfDay(new Date(item.lastMessageAt || 0)).toISOString()
}

export interface CollapsedPaginationResult {
  paginatedItems: SessionMeta[]
  hasMore: boolean
  collapsedGroupsMeta: CollapsedGroupMeta[]
}

export function computeCollapsedPagination(
  items: SessionMeta[],
  displayLimit: number,
  collapsedGroups?: Set<string>,
  groupingMode?: 'date' | 'status' | 'unread' | 'project',
): CollapsedPaginationResult {
  // 快路径：没有折叠状态，直接 slice
  if (!collapsedGroups || collapsedGroups.size === 0) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const groupKeysInView = new Set(items.map(item => getCollapseGroupKey(item, groupingMode)))

  // 安全兜底：如果当前过滤视图中只有一个分组，不允许全部折叠
  //（否则列表会完全为空，失去折叠交互意义）。
  if (groupKeysInView.size <= 1) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const effectiveCollapsedKeys = new Set(
    Array.from(collapsedGroups).filter(key => groupKeysInView.has(key))
  )

  if (effectiveCollapsedKeys.size === 0) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const expandedItems: SessionMeta[] = []
  const collapsedCounts = new Map<string, number>()

  for (const item of items) {
    const groupKey = getCollapseGroupKey(item, groupingMode)

    if (effectiveCollapsedKeys.has(groupKey)) {
      collapsedCounts.set(groupKey, (collapsedCounts.get(groupKey) || 0) + 1)
    } else {
      expandedItems.push(item)
    }
  }

  const meta: CollapsedGroupMeta[] = Array.from(collapsedCounts.entries()).map(
    ([key, count]) => ({ key, count })
  )

  return {
    paginatedItems: expandedItems.slice(0, displayLimit),
    hasMore: displayLimit < expandedItems.length,
    collapsedGroupsMeta: meta,
  }
}

interface FilterMatchOptions {
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, 'include' | 'exclude'>
  labelFilterMap?: Map<string, 'include' | 'exclude'>
  labelConfigs?: LabelConfig[]
}

export function sessionMatchesCurrentFilter(
  session: SessionMeta,
  currentFilter: SessionFilter | undefined,
  options: FilterMatchOptions = {}
): boolean {
  const { evaluateViews, statusFilter, labelFilterMap, labelConfigs } = options

  const passesStatusFilter = (): boolean => {
    if (!statusFilter || statusFilter.size === 0) return true
    const sessionState = (session.sessionStatus || 'todo') as string

    let hasIncludes = false
    let matchesInclude = false
    for (const [stateId, mode] of statusFilter) {
      if (mode === 'exclude' && sessionState === stateId) return false
      if (mode === 'include') {
        hasIncludes = true
        if (sessionState === stateId) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  const passesLabelFilter = (): boolean => {
    if (!labelFilterMap || labelFilterMap.size === 0) return true
    const sessionLabelIds = session.labels?.map(l => parseLabelEntry(l).id) || []

    let hasIncludes = false
    let matchesInclude = false
    for (const [labelId, mode] of labelFilterMap) {
      if (mode === 'exclude' && sessionLabelIds.includes(labelId)) return false
      if (mode === 'include') {
        hasIncludes = true
        if (sessionLabelIds.includes(labelId)) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  if (!passesStatusFilter() || !passesLabelFilter()) return false

  if (!currentFilter) return true

  switch (currentFilter.kind) {
    case 'allSessions':
      return session.isArchived !== true

    case 'flagged':
      return session.isFlagged === true && session.isArchived !== true

    case 'archived':
      return session.isArchived === true

    case 'state':
      return (session.sessionStatus || 'todo') === currentFilter.stateId && session.isArchived !== true

    case 'label': {
      if (session.isArchived === true) return false
      // Shared predicate (descendant-aware + optional project scope) — keep in
      // sync with AppShell's filtered set by construction, not by copy.
      return matchesLabelFilter(session, currentFilter, labelConfigs ?? [])
    }

    case 'view':
      if (session.isArchived === true) return false
      if (!evaluateViews) return true
      const matched = evaluateViews(session)
      if (currentFilter.viewId === '__all__') return matched.length > 0
      return matched.some(v => v.id === currentFilter.viewId)

    default:
      const _exhaustive: never = currentFilter
      return true
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSessionSearch({
  items,
  searchActive,
  searchQuery,
  workspaceId,
  currentFilter,
  evaluateViews,
  statusFilter,
  labelFilterMap,
  labelConfigs,
  collapsedGroups,
  groupingMode,
  scrollViewportRef,
}: UseSessionSearchOptions): UseSessionSearchResult {

  const [contentSearchResults, setContentSearchResults] = useState<Map<string, ContentSearchResult>>(new Map())
  const [isSearchingContent, setIsSearchingContent] = useState(false)
  const [isSearchUnavailable, setIsSearchUnavailable] = useState(false)
  const [displayLimit, setDisplayLimit] = useState(INITIAL_DISPLAY_LIMIT)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 搜索模式：搜索打开且关键词长度 >= 2
  const isSearchMode = searchActive && searchQuery.length >= 2
  const highlightQuery = isSearchMode ? searchQuery : undefined

  // --- 内容搜索（ripgrep IPC，带防抖与取消） ---

  useEffect(() => {
    if (!workspaceId || !isSearchMode) {
      setContentSearchResults(new Map())
      return
    }

    const searchId = Date.now().toString(36)
    searchLog.info('query:change', { searchId, query: searchQuery })

    let cancelled = false
    setIsSearchingContent(true)
    setIsSearchUnavailable(false)

    const timer = setTimeout(async () => {
      try {
        searchLog.info('ipc:call', { searchId })
        const ipcStart = performance.now()

        const results = await window.electronAPI.searchSessionContent(workspaceId, searchQuery, searchId)

        if (cancelled) return

        searchLog.info('ipc:received', {
          searchId,
          durationMs: Math.round(performance.now() - ipcStart),
          resultCount: results.length,
        })

        const resultMap = new Map<string, ContentSearchResult>()
        for (const result of results) {
          resultMap.set(result.sessionId, {
            matchCount: result.matchCount,
            snippet: result.matches[0]?.snippet || '',
          })
        }
        setContentSearchResults(resultMap)

        requestAnimationFrame(() => {
          searchLog.info('render:complete', { searchId, sessionsDisplayed: resultMap.size })
        })
      } catch (error) {
        if (cancelled) return
        // 区分搜索服务不可用（未找到 ripgrep）与临时错误
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('SearchUnavailableError') || message.includes('ripgrep')) {
          console.warn('[useSessionSearch] Search unavailable:', message)
          setIsSearchUnavailable(true)
        } else {
          console.error('[useSessionSearch] Content search error:', error)
        }
        setContentSearchResults(new Map())
      } finally {
        if (!cancelled) {
          setIsSearchingContent(false)
        }
      }
    }, 100)

    return () => {
      cancelled = true
      clearTimeout(timer)
      setIsSearchingContent(false)
    }
  }, [workspaceId, isSearchMode, searchQuery])

  // --- 搜索打开时自动聚焦输入框 ---

  useEffect(() => {
    if (searchActive) {
      searchInputRef.current?.focus()
    }
  }, [searchActive])

  // --- 数据管道 ---

  // 先过滤掉隐藏会话
  const visibleItems = useMemo(() => items.filter(item => !item.hidden), [items])

  // 按最近活动时间降序
  const sortedItems = useMemo(() =>
    [...visibleItems].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)),
    [visibleItems]
  )

  // 按搜索关键词或当前过滤器过滤
  const searchFilteredItems = useMemo(() => {
    if (!isSearchMode) {
      return sortedItems.filter(item =>
        sessionMatchesCurrentFilter(item, currentFilter, { evaluateViews, statusFilter, labelFilterMap, labelConfigs })
      )
    }

    return sortedItems
      .filter(item => contentSearchResults.has(item.id))
      .sort((a, b) => {
        const aScore = fuzzyScore(getSessionTitle(a), searchQuery)
        const bScore = fuzzyScore(getSessionTitle(b), searchQuery)

        if (aScore > 0 && bScore === 0) return -1
        if (aScore === 0 && bScore > 0) return 1
        if (aScore !== bScore) return bScore - aScore

        const countA = contentSearchResults.get(a.id)?.matchCount || 0
        const countB = contentSearchResults.get(b.id)?.matchCount || 0
        return countB - countA
      })
  }, [sortedItems, isSearchMode, searchQuery, contentSearchResults, currentFilter, evaluateViews, statusFilter, labelFilterMap, labelConfigs])

  // 拆分搜索结果：符合当前过滤器的 vs 其他
  const { matchingFilterItems, otherResultItems, exceededSearchLimit } = useMemo(() => {
    const hasActiveFilters =
      (currentFilter && currentFilter.kind !== 'allSessions') ||
      (statusFilter && statusFilter.size > 0) ||
      (labelFilterMap && labelFilterMap.size > 0)

    if (searchQuery.trim() && searchFilteredItems.length > 0) {
      searchLog.info('search:grouping', {
        searchQuery,
        currentFilterKind: currentFilter?.kind,
        currentFilterStateId: currentFilter?.kind === 'state' ? currentFilter.stateId : undefined,
        hasActiveFilters,
        statusFilterSize: statusFilter?.size ?? 0,
        labelFilterSize: labelFilterMap?.size ?? 0,
        itemCount: searchFilteredItems.length,
      })
    }

    const totalCount = searchFilteredItems.length
    const exceeded = totalCount > MAX_SEARCH_RESULTS

    if (!isSearchMode || !hasActiveFilters) {
      const limitedItems = searchFilteredItems.slice(0, MAX_SEARCH_RESULTS)
      return { matchingFilterItems: limitedItems, otherResultItems: [] as SessionMeta[], exceededSearchLimit: exceeded }
    }

    const matching: SessionMeta[] = []
    const others: SessionMeta[] = []

    for (const item of searchFilteredItems) {
      if (matching.length + others.length >= MAX_SEARCH_RESULTS) break

      const matches = sessionMatchesCurrentFilter(item, currentFilter, { evaluateViews, statusFilter, labelFilterMap, labelConfigs })
      if (matches) {
        matching.push(item)
      } else {
        others.push(item)
      }
    }

    if (searchFilteredItems.length > 0) {
      searchLog.info('search:grouping:result', {
        matchingCount: matching.length,
        othersCount: others.length,
        exceeded,
      })
    }

    return { matchingFilterItems: matching, otherResultItems: others, exceededSearchLimit: exceeded }
  }, [searchFilteredItems, currentFilter, evaluateViews, isSearchMode, statusFilter, labelFilterMap, labelConfigs, searchQuery])

  // --- 分页 ---

  useEffect(() => {
    setDisplayLimit(INITIAL_DISPLAY_LIMIT)
  }, [searchQuery])

  // 折叠感知分页：折叠项完全排除在 paginatedItems（以及 flatItems / 键盘导航）之外。
  // 它们的数量通过 collapsedGroupsMeta 返回，渲染层可展示仅含标题的分组。
  const { paginatedItems, hasMore, collapsedGroupsMeta } = useMemo(() => {
    return computeCollapsedPagination(searchFilteredItems, displayLimit, collapsedGroups, groupingMode)
  }, [searchFilteredItems, displayLimit, collapsedGroups, groupingMode])

  const loadMore = useCallback(() => {
    setDisplayLimit(prev => Math.min(prev + BATCH_SIZE, searchFilteredItems.length))
  }, [searchFilteredItems.length])

  // 基于滚动的分页：监听实际 ScrollArea 视口的滚动
  //（IntersectionObserver 的 root=null 检测不到 Radix ScrollArea 内部的滚动）
  useEffect(() => {
    if (!hasMore) return
    const viewport = scrollViewportRef?.current
    if (!viewport) return

    const check = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      if (scrollHeight - scrollTop - clientHeight < 200) {
        loadMore()
      }
    }

    check() // mount 时/分组展开后填满视口
    viewport.addEventListener('scroll', check, { passive: true })
    return () => viewport.removeEventListener('scroll', check)
  }, [hasMore, loadMore, displayLimit, scrollViewportRef])

  // --- 派生渲染数据 ---

  const dateGroups = useMemo(() => groupSessionsByDate(paginatedItems), [paginatedItems])

  const flatItems = useMemo(() => {
    if (isSearchMode) {
      return [...matchingFilterItems, ...otherResultItems]
    }
    return dateGroups.flatMap(group => group.sessions)
  }, [isSearchMode, matchingFilterItems, otherResultItems, dateGroups])

  const sessionIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatItems.forEach((item, index) => map.set(item.id, index))
    return map
  }, [flatItems])

  return {
    isSearchMode,
    highlightQuery,
    isSearchingContent,
    isSearchUnavailable,
    contentSearchResults,
    matchingFilterItems,
    otherResultItems,
    exceededSearchLimit,
    flatItems,
    dateGroups,
    sessionIndexMap,
    hasMore,
    collapsedGroupsMeta,
    searchInputRef,
  }
}
