/**
 * 文件：init-gate.ts
 * 位置：packages/server-core/src/domain
 * 职责：管理启动初始化状态，协调多个异步等待者。
 *
 * 架构角色：
 *   - 类似 Go 里的 sync.Once + errgroup 的组合：只允许“就绪”或“失败”结算一次，
 *     其他等待方通过同一个 Promise 得到结果。
 *   - 在 Electron/Server 启动流程中用来阻塞 IPC handler，等核心服务初始化完成再放行。
 *
 * Agent 开发关注点：
 *   - SessionManager、Auth 等依赖初始化完成后，才能安全地接受 Agent 会话请求。
 *   - 本 gate 保证要么全部准备好，要么统一失败，不会出现半初始化状态。
 *
 * TS 特性：
 *   - `Promise<void>` 表示“只关心完成，不返回数据”，类似 Go 的 `chan struct{}`。
 *   - `resolvePromise!: () => void` 中的 `!` 是“明确赋值断言”，
 *     告诉 TS 构造函数里一定会赋值；否则 TS 会报未初始化错误。
 */
export class InitGate {
  /** 是否已经 settle（resolve 或 reject 只能发生一次）。 */
  private settled = false

  /** 所有 wait() 调用者共享的 Promise。 */
  private readonly promise: Promise<void>

  /** Promise 的 resolve 句柄，延迟到 Promise 构造器里赋值。 */
  private resolvePromise!: () => void

  /** Promise 的 reject 句柄，延迟到 Promise 构造器里赋值。 */
  private rejectPromise!: (error: unknown) => void

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
  }

  /**
   * 等待初始化完成。
   *
   * 类比 Go：`select { case <-readyCh: ... }`。
   * 多个调用者可以并发 wait，结果相同。
   */
  wait(): Promise<void> {
    return this.promise
  }

  /**
   * 标记初始化成功。
   * 如果已经 settled，则幂等忽略（类似 sync.Once）。
   */
  markReady(): void {
    if (this.settled) return
    this.settled = true
    this.resolvePromise()
  }

  /**
   * 标记初始化失败。
   * 所有 wait() 的调用者会收到这个 error。
   */
  markFailed(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.rejectPromise(error)
  }
}
