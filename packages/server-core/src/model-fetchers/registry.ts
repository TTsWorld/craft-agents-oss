/**
 * 模型拉取器注册表
 *
 * 文件职责：
 *   - 维护 FetchableProvider → ModelFetcher 的映射。
 *   - 利用 TypeScript 的 Record/映射类型做编译期完备性检查：
 *     只要 FetchableProvider 联合类型增加新成员，而本对象缺少对应键，
 *     tsc 就会报错。这与 Golang 中 switch 语句处理 enum 后忘记加 default 的
 *     运行时检查不同，TS 把问题提前到编译期。
 *
 * 设计说明：
 *   - fetchers 都是无状态对象，可全局复用单例，避免每次 refresh 都 new。
 *   - Bedrock/Vertex 被合并到同一个 fetcher 中，因为它们都走后端驱动 discover。
 */

import type { ModelFetcherMap } from '@craft-agent/shared/config'
import { AnthropicModelFetcher } from './anthropic'
import { PiModelFetcher } from './pi'

// 复用无状态实例；类似于 Golang 里把 handler 做成全局依赖注入的单例
const anthropicFetcher = new AnthropicModelFetcher()
const piFetcher = new PiModelFetcher()

/**
 * 所有可拉取模型的 Provider 必须在此注册。
 * ModelRefreshService 通过 providerType 查找对应 fetcher，找不到则跳过刷新。
 */
export const MODEL_FETCHERS: ModelFetcherMap = {
  anthropic: anthropicFetcher,
  pi:        piFetcher,
}
