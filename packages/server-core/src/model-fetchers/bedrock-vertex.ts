/**
 * Bedrock / Vertex / OpenRouter 模型拉取器（stub 实现）
 *
 * 文件职责：
 *   - 处理 AWS Bedrock、Google Vertex、OpenRouter 等需要通过后端驱动 discover 的 Provider。
 *   - 这些 Provider 的可用模型通常由后端 SDK/CLI 决定，不会像 Anthropic 那样频繁变化，
 *     因此不启用周期性刷新；失败后直接回退到持久化缓存或 MODEL_REGISTRY。
 *
 * credential 刷新机制：
 *   - 上层 ModelRefreshService 调用 refreshConnection 前，会通过 credential resolver 获取
 *     最新凭证（例如 AWS credentials 的自动轮转、GCP access token 刷新）。
 *   - fetchBackendModels 接收到的 credentials 已经是“新鲜”的，不需要本文件再处理刷新。
 */

import type { ModelFetcher, ModelFetchResult, ModelFetcherCredentials } from '@craft-agent/shared/config'
import type { LlmConnection } from '@craft-agent/shared/config'
import { fetchBackendModels } from '@craft-agent/shared/agent/backend'
import { getHostRuntime } from './runtime'

/** Bedrock/Vertex 模型拉取器：不周期性刷新，依赖持久化缓存 / 注册表 */
export class BedrockVertexModelFetcher implements ModelFetcher {
  /** refreshIntervalMs = 0 表示不建立定时刷新；仅在显式触发时拉取 */
  readonly refreshIntervalMs = 0

  /**
   * 拉取模型列表
   * @param connection - LLM 连接配置
   * @param credentials - 已由上层刷新过的凭证
   */
  async fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult> {
    return fetchBackendModels({
      connection,
      credentials,
      timeoutMs: 15_000,
      hostRuntime: getHostRuntime(),
    })
  }
}
