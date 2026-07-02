/**
 * 模型刷新服务（Model Refresh Service）
 *
 * 文件职责：
 *   - 集中管理所有 Provider 的模型列表拉取与定时刷新。
 *   - 替代原先散落在各处的 fetchAndStore*Models() 与 startCodexModelRefresh()。
 *
 * 核心机制：
 *   1. 三级回退链（每个 Provider 通用）：
 *      - Layer 1: Provider 运行时发现（后端 driver 分派，可能调用 Anthropic API、
 *        AWS Bedrock CLI、Codex CLI 等）。
 *      - Layer 2: 持久化的 connection.models —— 之前成功拉取过，离线或重启后仍然可用。
 *      - Layer 3: MODEL_REGISTRY —— 硬编码的离线种子数据，最后一道兜底。
 *
 *   2. credential 刷新：
 *      - 本服务不直接持有密钥，而是通过构造时注入的 CredentialResolver 获取。
 *      - resolver 内部会处理 OAuth access token 刷新、AWS credential 轮转等。
 *      - 若 resolver 抛出异常，Layer 1 失败，进入 Layer 2/3 回退。
 *
 *   3. 并发去重：
 *      - 同一 slug 的 refreshConnection 若已在进行，新调用复用同一个 Promise，
 *        避免重复网络请求。这与 Golang 中用 sync.Once 或 singleflight 做请求合并
 *        的思想类似（这里是 Promise 级别的合并）。
 *
 * TS 特性小记：
 *   - `ReturnType<typeof setInterval>` 是类型系统从函数推断出的类型，等价于
 *     NodeJS.Timeout | number；用 ReturnType 可以少记一个具体类型名。
 *   - `private timers = new Map<...>()` 是类字段简写，同时声明字段并初始化。
 *   - 构造参数 `private fetchers: ModelFetcherMap` 是 TS 的“参数属性”语法，
 *     自动在类上创建同名私有字段并赋值，类似 Golang 结构体 embedding 的简化写法。
 */

import type { ModelFetcherMap, ModelFetcherCredentials, FetchableProvider } from '@craft-agent/shared/config'
import type { ModelDefinition } from '@craft-agent/shared/config'
import {
  getLlmConnections,
  getLlmConnection,
  updateLlmConnection,
  isCompatProvider,
  getModelsForProviderType,
} from '@craft-agent/shared/config'
import { MODEL_FETCHERS } from './registry'
import { handlerLog } from './runtime'

/** Copilot 模型由 GitHub 服务端策略管理，每 10 分钟刷新一次以感知策略变化 */
const COPILOT_REFRESH_INTERVAL_MS = 10 * 60 * 1000

// ============================================================
// 类型
// ============================================================

/** credential 解析器：根据连接 slug 异步获取（可能已刷新过的）凭证 */
type CredentialResolver = (slug: string) => Promise<ModelFetcherCredentials>

// ============================================================
// ModelRefreshService
// ============================================================

/** 模型刷新服务：负责单连接刷新、批量启动/停止定时器、回退链策略 */
class ModelRefreshService {
  /** slug → setInterval 定时器句柄 */
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  /** slug → 正在执行的 refresh Promise，用于并发去重 */
  private inFlight = new Map<string, Promise<void>>()

  constructor(
    private fetchers: ModelFetcherMap,
    private getCredentials: CredentialResolver,
  ) {}

  /**
   * 刷新指定连接的模型列表，带三级回退链。
   * 对同一 slug 的并发调用会复用同一个 Promise，避免重复请求。
   *
   * @param slug - LLM 连接的唯一标识
   */
  async refreshConnection(slug: string): Promise<void> {
    const existing = this.inFlight.get(slug)
    if (existing) return existing

    const promise = this._doRefresh(slug).finally(() => {
      this.inFlight.delete(slug)
    })
    this.inFlight.set(slug, promise)
    return promise
  }

  /**
   * 内部：真正的刷新逻辑 + 回退链。
   * - 跳过 compat provider（用户手动配置模型，不参与自动发现）。
   * - 成功时调用 updateLlmConnection 写入持久化存储。
   * - 保留用户当前 defaultModel 若其仍在新的模型列表中。
   */
  private async _doRefresh(slug: string): Promise<void> {
    const connection = getLlmConnection(slug)
    if (!connection) {
      handlerLog.warn(`Model refresh: connection not found: ${slug}`)
      return
    }

    // compat provider（如 openai-compatible）由用户手动维护模型列表，不参与自动拉取
    if (isCompatProvider(connection.providerType)) {
      return
    }

    const providerType = connection.providerType as FetchableProvider
    const fetcher = this.fetchers[providerType]
    if (!fetcher) {
      handlerLog.warn(`Model refresh: no fetcher for provider type: ${providerType}`)
      return
    }

    let newModels: ModelDefinition[] | null = null
    let serverDefault: string | undefined

    // Layer 1: Provider API / SDK（实时拉取）
    try {
      const credentials = await this.getCredentials(slug)
      handlerLog.info(`Model refresh [${slug}]: fetching (provider=${connection.providerType}, piAuth=${connection.piAuthProvider}, hasOAuthRefresh=${!!credentials.oauthRefreshToken}, hasOAuthAccess=${!!credentials.oauthAccessToken})`)
      const result = await fetcher.fetchModels(connection, credentials)
      newModels = result.models
      serverDefault = result.serverDefault
      handlerLog.info(`Model refresh [${slug}]: fetched ${newModels.length} models from provider: ${newModels.map(m => m.id).join(', ')}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      handlerLog.warn(`Model refresh [${slug}]: provider fetch failed: ${msg}`)
    }

    // Layer 2: 持久化缓存（如果实时拉取失败，保留旧列表，不覆盖）
    if (!newModels && connection.models && connection.models.length > 0) {
      handlerLog.warn(`Model refresh [${slug}]: keeping ${connection.models.length} stale persisted models (live fetch failed)`)
      return // Nothing to update
    }

    // Layer 3: MODEL_REGISTRY 硬编码兜底
    if (!newModels) {
      const registryModels = getModelsForProviderType(providerType, connection.piAuthProvider)
      if (registryModels.length > 0) {
        newModels = registryModels
        handlerLog.info(`Model refresh [${slug}]: using ${newModels.length} models from MODEL_REGISTRY`)
      }
    }

    if (!newModels || newModels.length === 0) {
      handlerLog.warn(`Model refresh [${slug}]: no models available from any source`)
      return
    }

    // 对于 Pi 连接：如果用户显式使用 userDefined3Tier 模式，不覆盖其模型列表。
    // 例外：Copilot 连接始终由服务端管理，必须接受实时 API 结果。
    const isCopilot = connection.providerType === 'pi' && connection.piAuthProvider === 'github-copilot'
    if (connection.providerType === 'pi' && connection.modelSelectionMode === 'userDefined3Tier' && !isCopilot) {
      const modelCount = connection.models?.length ?? 0
      handlerLog.info(`Model refresh [${slug}]: preserving user-defined Pi model list (${modelCount} models)`)
      if (modelCount > 10) {
        handlerLog.warn(`Model refresh [${slug}]: userDefined3Tier has suspicious model count (${modelCount})`)
      }
      return
    }

    // 保留用户当前默认模型，如果它仍然有效；否则回退到服务端默认或新列表第一个
    const currentDefault = connection.defaultModel
    const stillValid = currentDefault && newModels.some(m => m.id === currentDefault)
    const newDefault = stillValid
      ? currentDefault
      : serverDefault ?? newModels[0]?.id

    updateLlmConnection(slug, {
      models: newModels,
      ...(newDefault && !stillValid ? { defaultModel: newDefault } : {}),
    })
  }

  /**
   * 启动所有已存在连接的定时刷新。
   * 对每个连接会立即发起一次非阻塞刷新，然后按 provider 规则建立定时器。
   * 应在 IPC handlers 注册完成后、应用启动时调用。
   */
  startAll(): void {
    const connections = getLlmConnections()

    for (const conn of connections) {
      if (isCompatProvider(conn.providerType)) continue

      const providerType = conn.providerType as FetchableProvider
      const fetcher = this.fetchers[providerType]
      if (!fetcher) continue

      // 立即非阻塞刷新一次；用 .catch 避免 unhandled rejection
      this.refreshConnection(conn.slug).catch(err => {
        handlerLog.warn(`Initial model refresh failed for ${conn.slug}: ${err instanceof Error ? err.message : err}`)
      })

      // 建立周期性刷新：Copilot 用独立短间隔；其余使用 fetcher.refreshIntervalMs（0 表示不刷新）
      const isCopilot = conn.providerType === 'pi' && conn.piAuthProvider === 'github-copilot'
      if (isCopilot) {
        this.startTimer(conn.slug, COPILOT_REFRESH_INTERVAL_MS)
      } else if (fetcher.refreshIntervalMs > 0) {
        this.startTimer(conn.slug, fetcher.refreshIntervalMs)
      }
    }
  }

  /**
   * 停止所有定时刷新。应用退出时调用。
   */
  stopAll(): void {
    for (const [slug, timer] of this.timers) {
      clearInterval(timer)
      handlerLog.info(`Stopped model refresh timer for ${slug}`)
    }
    this.timers.clear()
  }

  /**
   * 立即触发一次指定连接的刷新，并在需要时启动/恢复定时器。
   * 典型调用时机：新建连接、授权完成、用户点击刷新按钮。
   */
  async refreshNow(slug: string): Promise<void> {
    await this.refreshConnection(slug)

    // 确保周期性定时器在运行
    const connection = getLlmConnection(slug)
    if (!connection || isCompatProvider(connection.providerType)) return

    const providerType = connection.providerType as FetchableProvider
    const fetcher = this.fetchers[providerType]
    const isCopilot = connection.providerType === 'pi' && connection.piAuthProvider === 'github-copilot'
    if (isCopilot && !this.timers.has(slug)) {
      this.startTimer(slug, COPILOT_REFRESH_INTERVAL_MS)
    } else if (fetcher && fetcher.refreshIntervalMs > 0 && !this.timers.has(slug)) {
      this.startTimer(slug, fetcher.refreshIntervalMs)
    }
  }

  /**
   * 停止指定连接的定时器。连接被删除时调用。
   */
  stopConnection(slug: string): void {
    const timer = this.timers.get(slug)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(slug)
    }
  }

  /** 启动定时器；若该 slug 已有定时器则忽略，防止重复 */
  private startTimer(slug: string, intervalMs: number): void {
    if (this.timers.has(slug)) return

    const timer = setInterval(async () => {
      try {
        await this.refreshConnection(slug)
      } catch (err) {
        handlerLog.warn(`Periodic model refresh failed for ${slug}: ${err instanceof Error ? err.message : err}`)
      }
    }, intervalMs)

    this.timers.set(slug, timer)
  }
}

// ============================================================
// 单例
// ============================================================

/** 模块级单例引用 */
let _service: ModelRefreshService | null = null

/**
 * 获取 ModelRefreshService 单例。
 * 使用前必须先调用 initModelRefreshService()，否则抛错。
 */
export function getModelRefreshService(): ModelRefreshService {
  if (!_service) {
    throw new Error('ModelRefreshService not initialized. Call initModelRefreshService() first.')
  }
  return _service
}

/**
 * 初始化 ModelRefreshService。
 * @param getCredentials - credential 解析器，负责在刷新前获取最新凭证
 */
export function initModelRefreshService(getCredentials: CredentialResolver): ModelRefreshService {
  _service = new ModelRefreshService(MODEL_FETCHERS, getCredentials)
  return _service
}

export { setFetcherPlatform } from './runtime'
