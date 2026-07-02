/**
 * 持久化 TurnCard 展开/折叠状态的 hook。
 *
 * 把展开状态保存在单个 localStorage 键中，采用有上限的 LRU Map
 * （最多 100 个会话）。默认折叠，因此只保存已展开的 ID。
 *
 * 结构：{ [sessionId]: { turns: string[], groups: string[], lastAccessed: number } }
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import * as storage from '@/lib/local-storage'

const MAX_SESSIONS = 100

/** 单个会话的展开状态条目 */
interface ExpansionEntry {
  turns: string[]
  groups: string[]
  lastAccessed: number
}

/** localStorage 中保存的完整映射 */
type ExpansionMap = Record<string, ExpansionEntry>

/** 从 localStorage 读取完整展开映射；解析失败返回空对象 */
function readMap(): ExpansionMap {
  return storage.get<ExpansionMap>(storage.KEYS.turnCardExpansion, {})
}

/**
 * 把展开映射写入 localStorage，超过 MAX_SESSIONS 时
 * 按 lastAccessed 升序丢弃最旧的条目。
 */
function writeMap(map: ExpansionMap): void {
  const entries = Object.entries(map)
  if (entries.length > MAX_SESSIONS) {
    // 按最后访问时间升序排序，只保留最近的 MAX_SESSIONS 条
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
    const pruned: ExpansionMap = {}
    const keep = entries.slice(entries.length - MAX_SESSIONS)
    for (const [key, value] of keep) {
      pruned[key] = value
    }
    storage.set(storage.KEYS.turnCardExpansion, pruned)
  } else {
    storage.set(storage.KEYS.turnCardExpansion, map)
  }
}

/**
 * 为指定会话持久化 TurnCard 展开状态。
 * 返回受控状态与回调，直接传给 TurnCard 组件使用。
 */
export function useTurnCardExpansion(sessionId: string | undefined) {
  // 从 localStorage 初始化当前会话的展开状态
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    if (!sessionId) return new Set()
    const map = readMap()
    const entry = map[sessionId]
    return entry ? new Set(entry.turns) : new Set()
  })

  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(() => {
    if (!sessionId) return new Set()
    const map = readMap()
    const entry = map[sessionId]
    return entry ? new Set(entry.groups) : new Set()
  })

  // 记录当前 sessionId，用于会话切换时保存/恢复
  const prevSessionIdRef = useRef(sessionId)

  // 会话切换时：保存当前状态并加载新会话的状态
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return

    // 加载新会话的展开状态
    if (sessionId) {
      const map = readMap()
      const entry = map[sessionId]
      setExpandedTurns(entry ? new Set(entry.turns) : new Set())
      setExpandedActivityGroups(entry ? new Set(entry.groups) : new Set())
    } else {
      setExpandedTurns(new Set())
      setExpandedActivityGroups(new Set())
    }

    prevSessionIdRef.current = sessionId
  }, [sessionId])

  // 展开状态变化时持久化到 localStorage。
  // 用 ref 避免闭包过期，只在有有效会话时写入。
  const expandedTurnsRef = useRef(expandedTurns)
  const expandedGroupsRef = useRef(expandedActivityGroups)
  expandedTurnsRef.current = expandedTurns
  expandedGroupsRef.current = expandedActivityGroups

  useEffect(() => {
    if (!sessionId) return
    const map = readMap()
    const turns = [...expandedTurnsRef.current]
    const groups = [...expandedGroupsRef.current]

    // 没有展开内容时移除该会话条目；有内容时才写入
    if (turns.length === 0 && groups.length === 0) {
      if (map[sessionId]) {
        delete map[sessionId]
        writeMap(map)
      }
      return
    }

    map[sessionId] = {
      turns,
      groups,
      lastAccessed: Date.now(),
    }
    writeMap(map)
  }, [sessionId, expandedTurns, expandedActivityGroups])

  // 切换单个 turn 的展开状态
  const toggleTurn = useCallback((turnId: string, expanded: boolean) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (expanded) {
        next.add(turnId)
      } else {
        next.delete(turnId)
      }
      return next
    })
  }, [])

  return {
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  }
}
