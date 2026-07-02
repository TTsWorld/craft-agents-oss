/**
 * 基于 Jotai 的会话级状态管理
 *
 * 使用 Jotai 管理每个会话（session）的状态。
 * 通过 atomFamily 为每个 session 创建独立的 atom，
 * 一个 session 的更新不会触发其他 session 组件的重渲染。
 *
 * 这解决了“在 Session A 流式输出时导致 Session B 重渲染并丢失焦点”的性能问题。
 *
 * 对 Go 同学：atomFamily 类似一个按 key 创建变量的工厂函数，
 * 每个 key 对应一块独立状态，互不干扰。
 */

import { atom } from 'jotai'
import type { Getter, Setter } from 'jotai/vanilla'
import { atomFamily } from 'jotai-family'
import type { Session, Message } from '../../shared/types'

/**
 * Session 元数据（用于列表展示，轻量，不含消息）
 * SessionList 用它避免在消息变化时重渲染
 */
export interface SessionMeta {
  id: string
  name?: string
  /** 第一条用户消息的预览（用作标题兜底） */
  preview?: string
  workspaceId: string
  lastMessageAt?: number
  isProcessing?: boolean
  isFlagged?: boolean
  lastReadMessageId?: string
  workingDirectory?: string
  enabledSourceSlugs?: string[]
  /** 通过 viewer 分享后的公开 URL */
  sharedUrl?: string
  /** 在 viewer 中的分享 session ID（用于撤销分享） */
  sharedId?: string
  /** 最后一条非中间态的 assistant/plan 消息 ID — 用于未读检测 */
  lastFinalMessageId?: string
  /**
   * 显式未读标记 — “NEW” 徽标的唯一真相源。
   * 当 assistant 完成回复而用户没有查看时设为 true；
   * 当用户查看该 session 且未在处理中时设为 false。
   */
  hasUnread?: boolean
  /** 用于过滤的标签（可叠加，一个 session 可有多个） */
  labels?: string[]
  /** 权限模式（'safe', 'ask', 'allow-all'）— 视图表达式使用 */
  permissionMode?: string
  /** 用于过滤的 session 状态 */
  sessionStatus?: string
  /** 最后一条消息的角色（用于在不加载消息时显示徽标） */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  /** 是否有异步操作进行中（分享、更新分享、撤销、标题重生成） */
  isAsyncOperationOngoing?: boolean
  /** @deprecated 请改用 isAsyncOperationOngoing */
  isRegeneratingTitle?: boolean
  /** 该 session 的模型覆盖 */
  model?: string
  /** 该 session 的 LLM 连接 slug */
  llmConnection?: string
  /** Token 用量统计（来自 JSONL 头，无需加载消息即可获得） */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    contextTokens: number
  }
  /** session 创建时间（毫秒时间戳） */
  createdAt?: number
  /** 该 session 消息总数 */
  messageCount?: number
  /** 为 true 时 session 在列表中隐藏（例如 mini edit sessions） */
  hidden?: boolean
  /** 是否已归档 */
  isArchived?: boolean
  /** 归档时间戳（用于保留策略） */
  archivedAt?: number
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /** Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus */
  kanbanColumn?: string
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes) */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (Conductor-owned children only) */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (Conductor-owned children only) */
  taskNodeId?: string
  /** Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator while children spawn lazily */
  taskNodeCount?: number
  /** Tasks Conductor: a generate-time draft orchestrator, hidden from the board until adopted by createTask. */
  taskDraft?: boolean
}

/**
 * 从消息数组中找到最后一条非中间态的 assistant 或 plan 消息 ID。
 * plan 消息也算最终回复，因为它是 AI 生成的内容。
 */
function findLastFinalMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate) {
      return msg.id
    }
  }
  return undefined
}

/**
 * 从完整 Session 对象中提取轻量元数据。
 * 通过解构去掉 SessionMeta 不需要的字段，再补充计算字段。
 */
export function extractSessionMeta(session: Session): SessionMeta {
  const messages = session.messages || []

  // 解构出在 SessionMeta 中不存在或需要覆盖的字段
  const {
    messages: _msgs, sessionFolderPath: _sf, supportsBranching: _sb,
    workspaceName: _wn, thinkingLevel: _tl, currentStatus: _cs,
    isAsyncOperationOngoing, isRegeneratingTitle,
    messageCount, lastFinalMessageId: sessionLastFinal,
    ...sessionFields
  } = session

  return {
    ...sessionFields,
    lastFinalMessageId: sessionLastFinal ?? findLastFinalMessageId(messages),
    // Math.max, not ??: streaming appends grow `messages` without touching the
    // session's `messageCount` field, so a defined-but-stale count (stamped at
    // load/creation) must never shadow the live length. Meta-only sessions
    // (empty `messages`) keep the server/header count.
    messageCount: Math.max(messageCount ?? 0, messages.length),
    isAsyncOperationOngoing: isAsyncOperationOngoing ?? isRegeneratingTitle,
    isRegeneratingTitle,
  } as SessionMeta
}

/**
 * 每个 session 对应一个独立 atom 的 atomFamily。
 * 更新被隔离：只订阅某个 session 的组件才会重渲染。
 */
export const sessionAtomFamily = atomFamily(
  (_sessionId: string) => atom<Session | null>(null),
  (a, b) => a === b
)

/**
 * session 元数据映射（用于列表展示）
 * 只包含 SessionList 所需的轻量数据
 */
export const sessionMetaMapAtom = atom<Map<string, SessionMeta>>(new Map())

/**
 * 派生 atom：排序后的 session ID 列表（用于列表顺序）
 */
export const sessionIdsAtom = atom<string[]>([])

/**
 * 记录哪些 session 的消息已经加载（用于懒加载）
 * session 初始化时 messages 为空，打开时才按需拉取
 */
export const loadedSessionsAtom = atom<Set<string>>(new Set<string>())

/**
 * Promise 缓存，用于去重并发 session 加载请求。
 * 防止竞态：多个调用（例如 React 重渲染）在第一次完成并标记 loaded 之前就发起加载。
 * 模块级 Map，因为它追踪的是进行中的 Promise，不是 React 状态。
 */
const sessionLoadingPromises = new Map<string, Promise<Session | null>>()

/**
 * 当前激活的 session ID — 主内容区显示的 session
 * 替代原来的基于 tab 的 session 选择
 */
export const activeSessionIdAtom = atom<string | null>(null)

// 注意：sessionsAtom 已被移除，以修复内存泄漏
// 之前包含消息的 sessions 数组被 Jotai 内部状态持有。
// 现在改为：
// - sessionMetaMapAtom：列表用，轻量元数据，不含消息
// - sessionAtomFamily(id)：单个 session 数据
// - initializeSessionsAtom：批量初始化
// - addSessionAtom、removeSessionAtom：单个增删

/**
 * Action atom：更新单个 session
 * 只触发订阅了该 session 的组件重渲染
 */
export const updateSessionAtom = atom(
  null,
  (get, set, sessionId: string, updater: (prev: Session | null) => Session | null) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const currentSession = get(sessionAtom)
    const newSession = updater(currentSession)
    set(sessionAtom, newSession)

    // 如果 session 存在，同步更新元数据
    if (newSession) {
      const metaMap = get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(newSession))
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom：只更新 session 元数据（用于列表展示更新）
 * 不影响完整 session atom
 */
export const updateSessionMetaAtom = atom(
  null,
  (get, set, sessionId: string, updates: Partial<SessionMeta>) => {
    const metaMap = get(sessionMetaMapAtom)
    const existing = metaMap.get(sessionId)
    if (existing) {
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, { ...existing, ...updates })
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom：用权威完整 session 载荷替换当前 session。
 *
 * 适用于 getSessionMessages() 或 createSession() 返回的数据，
 * 因为此时 messages 数组已知是完整的加载记录。
 * 在一个写入里同时更新完整 session atom 和 loadedSessionsAtom，
 * 防止聊天面板把真实消息藏在过时的懒加载 spinner 后面。
 */
export const replaceLoadedSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    set(sessionAtomFamily(session.id), session)

    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    const loadedSessions = get(loadedSessionsAtom)
    if (!loadedSessions.has(session.id)) {
      const newLoadedSessions = new Set(loadedSessions)
      newLoadedSessions.add(session.id)
      set(loadedSessionsAtom, newLoadedSessions)
    }
  }
)

/**
 * Action atom：向 session 追加消息（用于流式输出）
 * 优化为只更新特定 session
 * 注意：不更新 lastMessageAt —— 调用方需自己处理时间戳，
 * 避免中间态/工具消息导致 session 列表跳动
 */
export const appendMessageAtom = atom(
  null,
  (get, set, sessionId: string, message: Message) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (session) {
      set(sessionAtom, {
        ...session,
        messages: [...session.messages, message],
        // 这里不更新 lastMessageAt —— 只有用户消息和最终回复才应更新它
      })
    }
  }
)

/**
 * Action atom：更新 session 的流式内容
 * 用于 text_delta 事件 —— 追加到最后一条正在流式输出的消息
 */
export const updateStreamingContentAtom = atom(
  null,
  (get, set, sessionId: string, content: string, turnId?: string) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (!session) return

    const messages = [...session.messages]
    const lastMsg = messages[messages.length - 1]

    // 追加到现有的流式消息
    if (lastMsg?.role === 'assistant' && lastMsg.isStreaming &&
        (!turnId || lastMsg.turnId === turnId)) {
      messages[messages.length - 1] = {
        ...lastMsg,
        content: lastMsg.content + content,
      }
      set(sessionAtom, { ...session, messages })
    }
  }
)

/**
 * Action atom：从加载的数据初始化 sessions
 */
export const initializeSessionsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    // 清理上一个工作区遗留的 atom family 条目。
    // 不清理的话，切换工作区后旧 session ID 的孤立 atom 会留在内存里，
    // 订阅了旧 ID 的组件会看到过时/空数据。
    const oldIds = get(sessionIdsAtom)
    const newIdSet = new Set(sessions.map(s => s.id))
    for (const oldId of oldIds) {
      if (!newIdSet.has(oldId)) {
        sessionAtomFamily.remove(oldId)
        backgroundTasksAtomFamily.remove(oldId)
      }
    }
    // 重置已加载记录 —— 新工作区需要重新懒加载
    set(loadedSessionsAtom, new Set<string>())

    // 设置各个 session atom
    for (const session of sessions) {
      set(sessionAtomFamily(session.id), session)
    }

    // 构建元数据映射
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      metaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, metaMap)

    // 设置排序后的 ID（按 lastMessageAt 降序）
    const ids = sessions
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, ids)

    // 注意：不要在这里把 session 标记为 loaded
    // getSessions() 返回的 session messages: []，是为了省内存
    // 消息在 session 打开时通过 ensureSessionMessagesLoadedAtom 懒加载
    // 这样 300+ sessions 的初始内存从约 500MB 降到约 50MB
  }
)

/**
 * Action atom：在陈旧的重连后刷新 session 元数据。
 *
 * 与 initializeSessionsAtom（为切换工作区重置一切）不同，
 * 这里会保留已加载 session 的消息，只把被覆盖的仅元数据 session 标记为未加载以便重新拉取。
 *
 * 所有跨 atom 的修改都在一个写事务里完成，
 * 这样 React 订阅者看到的是一次一致更新，而不是中间状态。
 */
export const refreshSessionsMetadataAtom = atom(
  null,
  (
    get,
    set,
    payload: { sessions: Session[]; loadedSessionIds: Set<string>; removeMissing?: boolean }
  ): Map<string, SessionMeta> => {
    const { sessions, loadedSessionIds, removeMissing = true } = payload

    // 只在权威刷新时移除陈旧 session。非破坏式刷新可能收到睡眠/唤醒后的临时局部列表；
    // 把它当作权威列表会导致侧边栏折叠成只剩单个激活 session。
    const currentIds = get(sessionIdsAtom)
    const latestIds = new Set(sessions.map(s => s.id))
    if (removeMissing) {
      for (const staleId of currentIds) {
        if (!latestIds.has(staleId)) {
          set(removeSessionAtom, staleId)
        }
      }
    }

    // 更新每个 session atom，保留已加载 session 的消息
    const unloadedIds: string[] = []
    for (const session of sessions) {
      const currentSession = get(sessionAtomFamily(session.id))
      const shouldPreserveMessages = !!currentSession && loadedSessionIds.has(session.id)
      const nextSession = shouldPreserveMessages && currentSession
        ? { ...session, messages: currentSession.messages }
        : session

      set(sessionAtomFamily(session.id), nextSession)

      // 记录丢失了消息的 session，让懒加载重新拉取
      if (!shouldPreserveMessages && loadedSessionIds.has(session.id)) {
        unloadedIds.push(session.id)
      }
    }

    // 从 loadedSessionsAtom 中移除被覆盖的 session
    if (unloadedIds.length > 0) {
      const nextLoaded = new Set(get(loadedSessionsAtom))
      for (const id of unloadedIds) nextLoaded.delete(id)
      set(loadedSessionsAtom, nextLoaded)
    }

    // 构建并设置元数据映射。非破坏式刷新从现有映射开始，
    // 这样被临时局部响应省略的 session 仍然可见；返回的 session 对自身字段仍是权威的。
    const nextMetaMap = removeMissing
      ? new Map<string, SessionMeta>()
      : new Map(get(sessionMetaMapAtom))
    for (const session of sessions) {
      nextMetaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, nextMetaMap)

    // 从实际暴露给 UI 的元数据映射中生成排序 ID
    const nextIds = Array.from(nextMetaMap.values())
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, nextIds)

    return nextMetaMap
  }
)

/**
 * Action atom：新增一个 session
 */
export const addSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    // 设置 session atom
    set(sessionAtomFamily(session.id), session)

    // 加入元数据映射
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    // 加到 ID 列表开头
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, [session.id, ...ids])

    // 标记为已加载（新 session 是完整的，不需要懒加载）
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.add(session.id)
    set(loadedSessionsAtom, newLoadedSessions)
  }
)

/**
 * Action atom：移除一个 session
 */
export const removeSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    // 先把 session atom 值清空
    set(sessionAtomFamily(sessionId), null)
    // 从 family 缓存中移除，允许 GC 回收 atom 及其存储值
    sessionAtomFamily.remove(sessionId)

    // 从元数据映射中移除
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.delete(sessionId)
    set(sessionMetaMapAtom, newMetaMap)

    // 从 ID 列表中移除
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, ids.filter(id => id !== sessionId))

    // 从已加载记录中移除
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, newLoadedSessions)

    // 清理其他 per-session atom family，防止内存泄漏
    // 这些存储的是应该被 GC 的 per-session UI 状态
    backgroundTasksAtomFamily.remove(sessionId)
  }
)

/**
 * Action atom：把 React state 同步到 per-session atoms
 *
 * 这是混合方案的关键：
 * - React state（sessions 数组）仍然是真相源
 * - 这个 atom 自动把变化同步到 per-session atoms
 * - 使用 useSession(id) 的组件得到隔离更新
 * - Jotai 的引用相等性防止不必要的重渲染
 *
 * 重要：流式输出期间，atom 才是真相源。
 * 流式事件（text_delta、tool_start、tool_result）直接更新 atoms，
 * 绕过 React state 以提升性能。对于正在处理的 session 一定不能覆盖 atom，
 * 否则会丢失流式数据（工具调用、文本）。
 * 一旦收到 handoff 事件（complete、error 等），React state 会追上来，
 * 同步恢复正常。
 */
export const syncSessionsToAtomsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    const loadedSessions = get(loadedSessionsAtom)

    // 更新每个 session atom
    for (const session of sessions) {
      const sessionAtom = sessionAtomFamily(session.id)
      const atomSession = get(sessionAtom)

      // 关键：如果 atom 里的 session 正在处理，说明它有流式更新，
      // 而 React state 还不知道。不要覆盖 —— 流式期间 atom 是真相源。
      // handoff 事件会来调和。
      if (atomSession?.isProcessing) {
        continue
      }

      // 关键：如果消息已懒加载，atom 有完整消息，但 React state 可能为空数组。
      // 只有当 React 消息更少时（会丢失数据）才跳过同步；
      // 如果 React 消息更多（例如用户刚发了消息），允许同步。
      if (loadedSessions.has(session.id) && atomSession) {
        const atomMessageCount = atomSession.messages?.length ?? 0
        const reactMessageCount = session.messages?.length ?? 0
        // 只有 React 消息更少时才跳过，防止丢失数据
        if (reactMessageCount < atomMessageCount) {
          continue
        }
      }

      // 仅当 session 对象真的不同（引用检查）时才更新
      // 避免 session 没变化时触发不必要的重渲染
      if (atomSession !== session) {
        set(sessionAtom, session)
      }
    }

    // 更新列表展示的元数据映射
    // 注意：仍然从 React state 更新元数据，没问题，因为元数据不含消息
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      const meta = extractSessionMeta(session)
      // 如果 atom 正在处理，保留它的 isProcessing
      // React state 在流式期间可能还是 isProcessing: false
      const atomSession = get(sessionAtomFamily(session.id))
      if (atomSession?.isProcessing) {
        meta.isProcessing = true
      }
      metaMap.set(session.id, meta)
    }
    set(sessionMetaMapAtom, metaMap)

    // 更新排序 ID（保留 React state 的顺序）
    set(sessionIdsAtom, sessions.map(s => s.id))
  }
)

// loadedSessionsAtom 已经提前定义，因为 syncSessionsToAtomsAtom 需要引用它

/**
 * Action atom：如果尚未加载，则加载 session 消息。
 * 返回加载后的 session；如果已经加载则返回当前 session。
 * 使用 Promise 去重防止并发请求的重复 IPC 调用。
 *
 * 重要：这里只把消息合并进现有 session atom。
 * UI 状态字段（hasUnread、isFlagged、sessionStatus 等）保留内存 atom 中的值，
 * 不会被可能陈旧的磁盘数据覆盖。
 * 这防止了竞态：用户查看 session 后清除了 NEW 徽标的乐观更新，
 * 不会被异步加载时读到的旧状态覆盖。
 */
async function loadSessionMessages(
  get: Getter,
  set: Setter,
  sessionId: string,
  options?: { force?: boolean },
): Promise<Session | null> {
  const force = options?.force ?? false

  if (force) {
    const nextLoadedSessions = new Set(get(loadedSessionsAtom))
    nextLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, nextLoadedSessions)

    // 清理任何进行中的旧请求，让调用方得到一次全新拉取
    sessionLoadingPromises.delete(sessionId)
  } else {
    const loadedSessions = get(loadedSessionsAtom)

    // 已经加载，直接返回当前 session
    if (loadedSessions.has(sessionId)) {
      return get(sessionAtomFamily(sessionId))
    }
  }

  // 检查是否已经在加载 —— 返回现有 Promise 以去重并发调用
  const existingPromise = sessionLoadingPromises.get(sessionId)
  if (existingPromise) {
    return existingPromise
  }

  // 创建 loading Promise，里面包含所有拉取和更新逻辑
  const loadPromise = (async (): Promise<Session | null> => {
    // 从主进程拉取消息
    const loadedSession = await window.electronAPI.getSessionMessages(sessionId)
    if (!loadedSession) {
      return get(sessionAtomFamily(sessionId))
    }

    // 把消息和只有磁盘才有的字段合并进现有 session，同时保留内存里的 UI 状态。
    // 渲染进程的 atom 对 UI 字段（hasUnread、isFlagged 等）是权威的，
    // 因为自磁盘写入以来可能已有乐观更新。
    // tokenUsage 和 sessionFolderPath 只有 getSession() 返回（getSessions() 不返回），
    // 所以这里必须显式合并，才能在应用重启后可用。
    const existingSession = get(sessionAtomFamily(sessionId))
    const preservedStaleMessages = !!existingSession
      && existingSession.messages.length > 0
      && (!loadedSession.messages || loadedSession.messages.length === 0)

    const mergedSession = existingSession
      ? {
          ...existingSession,
          // 关键：如果 session 正在流式输出且 atom 里已有消息，不要覆盖消息。
          // 流式事件直接更新 atom，可能包含 IPC 响应不知道的中间内容
          // （IPC 请求和响应之间的竞态窗口）。
          // messages.length > 0 这个守卫保证 Cmd+R 重载后正常工作：
          // 重载后 atom 从 getSessions() 拿到 messages=[]，所以必须使用
          // 主进程内存里的完整历史 IPC 响应。
          // 也防护睡眠/唤醒边界情况：服务端可能在子进程还没完成懒加载时返回空消息。
          messages: preservedStaleMessages
            ? existingSession.messages
            : existingSession.isProcessing && existingSession.messages.length > 0
              ? existingSession.messages
              : loadedSession.messages,
          tokenUsage: loadedSession.tokenUsage ?? existingSession.tokenUsage,
          sessionFolderPath: loadedSession.sessionFolderPath ?? existingSession.sessionFolderPath,
        }
      : loadedSession
    set(sessionAtomFamily(sessionId), mergedSession)

    // 只在元数据里更新 lastFinalMessageId（现在可以根据已加载消息计算出来）。
    // 不要替换完整 meta 条目 —— 其他字段由乐观更新和 IPC 事件维护，可能领先于磁盘状态。
    const lastFinalMessageId = findLastFinalMessageId(loadedSession.messages)
    if (lastFinalMessageId) {
      const metaMap = get(sessionMetaMapAtom)
      const existingMeta = metaMap.get(sessionId)
      if (existingMeta && existingMeta.lastFinalMessageId !== lastFinalMessageId) {
        const newMetaMap = new Map(metaMap)
        newMetaMap.set(sessionId, { ...existingMeta, lastFinalMessageId })
        set(sessionMetaMapAtom, newMetaMap)
      }
    }

    // 只有收到真正新载荷时才标记为已加载。
    // 如果因为后端懒加载恢复期间返回空数组而不得不保留陈旧内存消息，
    // 则保持该 session 可重新加载。
    if (!preservedStaleMessages) {
      const newLoadedSessions = new Set(get(loadedSessionsAtom))
      newLoadedSessions.add(sessionId)
      set(loadedSessionsAtom, newLoadedSessions)
    }

    return mergedSession
  })()

  // 在 await 之前缓存 Promise
  sessionLoadingPromises.set(sessionId, loadPromise)

  try {
    return await loadPromise
  } finally {
    // 无论成功失败都清理缓存
    sessionLoadingPromises.delete(sessionId)
  }
}

export const ensureSessionMessagesLoadedAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId)
  }
)

/**
 * Action atom：即使 session 当前标记为已加载，也强制刷新消息。
 * 用于重连恢复时 session atom 卡在“已加载但为空”的状态。
 */
export const forceSessionMessagesReloadAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId, { force: true })
  }
)

/**
 * ActiveTasksBar 展示的后台任务
 */
/**
 * Lifecycle status of a background task chip.
 * - `running`  — backgrounded, no terminal signal yet (chip shows a spinner + live elapsed).
 * - `completed`/`failed`/`stopped` — a real task_completed notification arrived.
 * - `orphaned` — the turn that owned the task ended before it finished, so it was
 *   terminated with that turn's subprocess. Shown distinctly instead of a false
 *   "running". Not produced once WS2 keep-alive is enabled.
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

export interface BackgroundTask {
  /** 任务或 shell ID */
  id: string
  /** 任务类型。'workflow' = 扇出式 Workflow 启动（多个子 agent） */
  type: 'agent' | 'shell' | 'workflow'
  /** 用于与消息关联的工具调用 ID */
  toolUseId: string
  /** Workflow 运行 ID（wf_...）—— 仅 type 为 'workflow' 时设置；用于关联 agent 完成更新 */
  workflowId?: string
  /** 目前已完成的子 agent 数量（仅 type 为 'workflow'） */
  agentsCompleted?: number
  /** 任务开始时间 */
  startTime: number
  /** 已过去秒数（来自进度事件；chip 也会从 startTime 推导） */
  elapsedSeconds: number
  /** 任务意图/描述 */
  intent?: string
  /** Lifecycle status; defaults to 'running' when added */
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal/orphaned status */
  completedAt?: number
  /** Output file for click-through, set when task_completed arrives */
  outputFile?: string
  /** Short summary, set when task_completed arrives */
  summary?: string
}

/**
 * 追踪每个 session 活跃后台任务的 atom family。
 * 在 task_backgrounded、shell_backgrounded、task_progress 事件时更新；
 * 任务完成或被 kill 时清空。
 */
export const backgroundTasksAtomFamily = atomFamily(
  (_sessionId: string) => atom<BackgroundTask[]>([]),
  (a, b) => a === b
)

/**
 * 当前窗口的工作区 ID —— 在 Root（ThemeProvider）和 App 之间共享。
 * App 在工作区切换时写入，Root 读取以保持主题同步。
 */
export const windowWorkspaceIdAtom = atom<string | null>(null)

/**
 * “Send to Workspace” 弹窗状态。
 * 设置要打开的 session ID 列表；清空数组表示关闭弹窗。
 */
export const sendToWorkspaceAtom = atom<string[]>([])
