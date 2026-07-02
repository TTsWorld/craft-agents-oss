/**
 * 文件：session-branch-cleanup.ts
 * 位置：packages/server-core/src/domain
 * 职责：Session 分支（branch）创建失败时的尽力回滚清理。
 *
 * 架构角色：
 *   - domain 层纯函数，接收清理句柄和删除回调，不直接操作 IPC/文件系统。
 *   - 类似 Go 里 `defer cleanup()` 的跨语言模拟：在预检阶段失败时把脏数据清掉。
 *
 * Agent 开发关注点：
 *   - 分支是 Agent 会话的树状结构（父 session + 子 session）。
 *   - 如果后端预检失败，必须防止孤儿 session 留在内存或持久化存储中。
 *   - 清理顺序：先停 Agent，再停 pool server，最后从 runtime 和存储中移除。
 */

/**
 * 需要被回滚的已创建会话对象。
 *
 * TS 特性：
 *   - `agent?: { destroy?: () => void } | null` 表示 agent 可能不存在、可能为 null，
 *     且即使存在，destroy 方法也是可选的。
 *   - 这种“深度可选”写法比 Go 的指针 + interface 组合更啰嗦，但类型信息更精确。
 */
export interface BranchRollbackManagedSession {
  agent?: { destroy?: () => void } | null
  poolServer?: { stop?: () => void }
}

/**
 * 回滚参数集合。
 *
 * TS 特性：
 *   - `deleteStoredSession` 的返回类型 `(sessionId: string) => void | boolean | Promise<void | boolean>`
 *     是“函数返回联合类型”，表示它可能是同步也可能是异步，返回也可能为空或布尔。
 *     调用方统一用 await 即可兼容三种情况（await 同步值会立即返回）。
 */
interface RollbackParams {
  managed: BranchRollbackManagedSession
  workspaceRootPath: string
  sessionId: string
  deleteFromRuntimeSessions: (sessionId: string) => void
  deleteStoredSession: (workspaceRootPath: string, sessionId: string) => void | boolean | Promise<void | boolean>
}

/**
 * 分支创建失败时的最佳努力回滚。
 *
 * 逻辑：
 *   1. 尝试销毁 Agent，失败也继续。
 *   2. 尝试停止 poolServer，失败也继续。
 *   3. 从 runtime sessions 中删除。
 *   4. 尝试从持久化存储中删除，失败也继续。
 *
 * TS 特性：
 *   - `managed.agent?.destroy?.()` 是连续可选链调用：
 *     agent 不存在、destroy 不存在、destroy 抛异常都不阻塞后续逻辑。
 *   - `try { ... } catch { ... }` 省略异常变量，只关心“有没有失败”。
 */
export async function rollbackFailedBranchCreation(params: RollbackParams): Promise<void> {
  const { managed, workspaceRootPath, sessionId, deleteFromRuntimeSessions, deleteStoredSession } = params

  try {
    managed.agent?.destroy?.()
  } catch {
    // 尽力清理：销毁失败也不中断后续回滚步骤
  }
  // 释放引用，帮助垃圾回收
  managed.agent = null

  if (managed.poolServer) {
    try {
      managed.poolServer.stop?.()
    } catch {
      // 尽力清理：停止失败也不中断回滚
    }
    // 清除 poolServer 引用
    managed.poolServer = undefined
  }

  deleteFromRuntimeSessions(sessionId)

  try {
    await deleteStoredSession(workspaceRootPath, sessionId)
  } catch {
    // 尽力回滚：运行时清理才是关键路径，持久化清理失败不影响整体结果
  }
}
