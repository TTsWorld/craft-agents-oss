/**
 * Model Fetcher — 集中式模型发现接口。
 *
 * 这是一个类型安全的插件接口：每个 LLM 提供商（Anthropic、Pi）都实现 ModelFetcher。
 * ModelFetcherMap 在编译期保证每个可自动获取模型的 provider 都有对应的 fetcher；
 * 如果新增了一种 LlmProviderType 但没注册 fetcher，TS 会直接报错。
 *
 * pi_compat（兼容/自定义端点）被排除在外，因为它们的端点是任意的，
 * 需要用户手动配置模型列表。
 */

import type { ModelDefinition } from './models';
import type { LlmProviderType, LlmConnection } from './llm-connections';

// ============================================================
// 类型定义
// ============================================================

/**
 * 支持自动拉取模型列表的提供商。
 * pi_compat 被排除：它们指向 Ollama、OpenRouter 等任意端点，由用户手动配模型。
 *
 * 如果新增 LlmProviderType 但没有同步更新这里，会在 fetcher 注册处产生编译错误，
 * 强制开发者补全实现。
 */
export type FetchableProvider = Exclude<LlmProviderType,
  | 'pi_compat'
>;

/** 一次模型拉取操作的结果 */
export interface ModelFetchResult {
  /** 拉取到的模型列表 */
  models: ModelDefinition[];
  /** 提供商推荐的默认模型（可选） */
  serverDefault?: string;
}

/**
 * 拉取模型时需要的凭据。
 * ModelRefreshService 会从 credential manager 中解析出这些值。
 */
export interface ModelFetcherCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

/**
 * 提供商专属的模型发现插件接口。
 *
 * 具体实现位于 apps/electron/src/main/model-fetchers/。
 * 每个 provider 用自己的 SDK/API 实现 fetchModels()，相当于 Go 里的接口实现。
 */
export interface ModelFetcher {
  /**
   * 从提供商 API/SDK 拉取模型列表。
   * 失败时抛异常，由 ModelRefreshService 负责兜底处理。
   */
  fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult>;

  /**
   * 自动刷新间隔（毫秒）。
   * 0 表示只在授权/启动时拉取一次，不周期性刷新。
   */
  readonly refreshIntervalMs: number;
}

/**
 * 类型安全的 fetcher 映射表：每个 FetchableProvider 都必须有对应的 ModelFetcher。
 * 新增 provider 没注册 fetcher 时，这里会产生编译错误。
 */
export type ModelFetcherMap = Record<FetchableProvider, ModelFetcher>;
