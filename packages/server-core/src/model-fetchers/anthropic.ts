/**
 * Anthropic 模型拉取器
 *
 * 文件职责：
 *   - 作为 Anthropic Provider 的模型发现入口，实现 ModelFetcher 契约。
 *   - 本身不直接发 HTTP，而是把模型列表请求委托给后端驱动（fetchBackendModels）。
 *     这与 Golang 中把具体 RPC 调用收敛到 client/adapter 层的做法类似。
 *
 * TS 特性小记：
 *   - `implements ModelFetcher` 是显式声明实现接口，可选但推荐；
 *     TypeScript 的接口是“鸭子类型/结构类型”，即使不写 implements，只要类的
 *     public 形状与接口一致，也可以当作该接口使用（类似 Golang 的隐式 interface 实现）。
 *   - `readonly refreshIntervalMs` 相当于只读常量成员，初始化后不可重新赋值。
 */

import type { ModelFetcher, ModelFetchResult, ModelFetcherCredentials } from '@craft-agent/shared/config'
import type { LlmConnection } from '@craft-agent/shared/config'
import { fetchBackendModels } from '@craft-agent/shared/agent/backend'
import { handlerLog } from './runtime'
import { getHostRuntime } from './runtime'

/** Anthropic 模型列表请求超时：30 秒 */
const ANTHROPIC_TIMEOUT_MS = 30_000

/** Anthropic 模型拉取器：定时刷新间隔为 60 分钟 */
export class AnthropicModelFetcher implements ModelFetcher {
  /** 每 60 分钟刷新一次模型列表；ModelRefreshService 据此建立 setInterval */
  readonly refreshIntervalMs = 60 * 60 * 1000

  /**
   * 拉取模型列表
   * @param connection - LLM 连接配置（含 providerType、apiKey、baseUrl 等）
   * @param credentials - 经过 credential 刷新后的凭证（可能已刷新过 OAuth access token）
   * @returns 模型定义列表 + 服务端默认模型
   */
  async fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult> {
    const result = await fetchBackendModels({
      connection,
      credentials,
      timeoutMs: ANTHROPIC_TIMEOUT_MS,
      hostRuntime: getHostRuntime(),
    })

    handlerLog.info(`Fetched ${result.models.length} Anthropic models: ${result.models.map(m => m.id).join(', ')}`)
    return result
  }
}
