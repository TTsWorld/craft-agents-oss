/**
 * Pi (Codex / GitHub Copilot) 模型拉取器
 *
 * 文件职责：
 *   - 处理 Pi Provider 的模型发现，包括本地 Codex CLI 与 GitHub Copilot OAuth 两种授权方式。
 *   - Pi 的模型列表一般由后端 SDK/CLI 提供，版本随应用升级而更新，因此不启用周期性刷新。
 *
 * credential 刷新机制：
 *   - Pi 可能使用 OAuth（如 GitHub Copilot），上层 credential resolver 会在调用前尝试刷新
 *     access token；如果刷新失败，refreshConnection 会回退到 MODEL_REGISTRY。
 *   - Copilot 涉及 CLI 冷启动 + 网络调用，因此超时设得较长（30 秒）。
 */

import type { ModelFetcher, ModelFetchResult, ModelFetcherCredentials } from '@craft-agent/shared/config'
import type { LlmConnection } from '@craft-agent/shared/config'
import { fetchBackendModels } from '@craft-agent/shared/agent/backend'
import { getHostRuntime } from './runtime'

/** Pi 模型拉取器：模型列表静态，不周期性刷新 */
export class PiModelFetcher implements ModelFetcher {
  /** refreshIntervalMs = 0 表示不建立定时刷新 */
  readonly refreshIntervalMs = 0

  /**
   * 拉取模型列表
   * @param connection - LLM 连接配置（含 piAuthProvider 区分 Codex/Copilot）
   * @param credentials - 已由上层刷新过的凭证
   */
  async fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult> {
    // Copilot OAuth 需要先启动 CLI 再调 API，超时给 30 秒；普通 Pi 15 秒
    const isCopilot = connection.piAuthProvider === 'github-copilot'
    return fetchBackendModels({
      connection,
      credentials,
      timeoutMs: isCopilot ? 30_000 : 15_000,
      hostRuntime: getHostRuntime(),
    })
  }
}
