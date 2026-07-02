/**
 * 文件：oauth-flow-store-interface.ts
 * 位置：packages/server-core/src/handlers
 * 职责：定义待处理 OAuth 流程存储的抽象接口 IOAuthFlowStore。
 *
 * 架构角色：
 *   - handlers 层只声明“我需要一个能存取 PendingOAuthFlow 的地方”，不关心具体存储。
 *   - 实现可放在内存、Redis、数据库等；@craft-agent/shared/auth 里有标准实现。
 *   - 类似 Go 中 handler 依赖一个接口，由 main 注入具体实现（依赖注入）。
 *
 * Agent 开发关注点：
 *   - OAuth 用于授权 LLM provider（如 Claude Max、GitHub Copilot）。
 *   - 授权流程是异步的：用户点击授权 → 服务端生成 state → 回调时根据 state 找回上下文。
 *   - state 必须短期有效，防止 CSRF 攻击。
 *
 * TS 特性：
 *   - `import type { PendingOAuthFlow }` 是“类型导入”，只引入类型信息，
 *     编译后不会生成运行时代码；类似 Go 的 import 但只在编译期使用。
 *   - 接口方法签名简洁：store/get/remove，分别对应增、查、删。
 */

import type { PendingOAuthFlow } from '@craft-agent/shared/auth'

export interface IOAuthFlowStore {
  /** 保存一个待处理的 OAuth 流程。 */
  store(flow: PendingOAuthFlow): void

  /** 根据 state 查找并返回待处理流程；找不到返回 null。 */
  getByState(state: string): PendingOAuthFlow | null

  /** 根据 state 删除待处理流程。 */
  remove(state: string): void
}
