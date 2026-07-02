/**
 * 文件：session-browser-release.ts
 * 位置：packages/server-core/src/domain
 * 职责：当 Agent 会话被强制停止时，释放该会话占用的浏览器所有权。
 *
 * 触发场景：
 *   - 用户提交了新 plan
 *   - 权限/认证中断
 *   - 用户手动停止 Agent
 *
 * 架构角色：
 *   - domain 层工具函数，不依赖 Electron 具体实现。
 *   - 通过接口契约（BrowserOwnershipReleaser）与底层 BrowserPaneManager 解耦。
 *
 * Agent 开发关注点：
 *   - 浏览器实例和 session 是“绑定”关系：一个 browser 实例可能只属于一个 session。
 *   - 强制停止 Agent 时必须解绑，否则下一次会话复用旧 browser 状态会出错。
 */

/**
 * 浏览器所有权释放器接口。
 *
 * 类比 Go：
 *   - 相当于 `interface BrowserOwnershipReleaser { ... }`，
 *     只要 Electron 的 BrowserPaneManager 提供这两个方法，就能被本函数使用（结构化类型）。
 *
 * TS 特性：
 *   - TypeScript 是“结构化类型系统”（structural typing），不需要显式 implements，
 *     只要形状一致即可传入。这和 Go 的接口 duck typing 类似。
 */
export type BrowserOwnershipReleaser = {
  clearVisualsForSession(sessionId: string): Promise<void>
  unbindAllForSession(sessionId: string): void
}

/**
 * 释放指定 session 的浏览器所有权。
 *
 * 参数设计：
 *   - source 可以是直接句柄，也可以是 `(sessionId) => releaser` 的工厂函数。
 *   - 使用工厂函数可以避免把 sessionId 泄漏到 releaser 类型里，
 *     因为 server 路径下实际持有的是 RemoteBrowserPaneManager，需要按 session 解析。
 *
 * TS 特性：
 *   - `source: BrowserOwnershipReleaser | ((sessionId: string) => BrowserOwnershipReleaser | null) | null | undefined`
 *     是一个联合类型，包含对象、函数、null、undefined 四种可能。
 *   - `typeof source === 'function'` 是类型保护，进入分支后 TS 知道 source 是函数。
 *   - `if (!source) return` 中 `!source` 会过滤掉 null/undefined/空字符串/0/false，
 *     这里 source 只可能是对象/函数/null/undefined，所以等价于“无句柄直接返回”。
 */
export async function releaseBrowserOwnershipOnForcedStop(
  source: BrowserOwnershipReleaser | ((sessionId: string) => BrowserOwnershipReleaser | null) | null | undefined,
  sessionId: string,
): Promise<void> {
  if (!source) return
  const releaser = typeof source === 'function' ? source(sessionId) : source
  if (!releaser) return
  await releaser.clearVisualsForSession(sessionId)
  releaser.unbindAllForSession(sessionId)
}
