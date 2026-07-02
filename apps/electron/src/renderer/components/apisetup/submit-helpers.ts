import type { CustomEndpointApi, CustomEndpointConfig } from '@config/llm-connections'

/** 预设（preset）的键名，例如 'anthropic'、'openai'、'custom'。 */
export type PresetKey = string

/**
 * 需要映射到 Pi SDK 标准 provider 名称的预设别名。
 * Pi SDK 同时把 'minimax' 和 'minimax-cn' 视为两个独立 provider
 *（分别对应 api.minimax.io 与 api.minimaxi.com），
 * 只有 'minimax-global' 需要被映射成 'minimax'。
 */
const PI_AUTH_PROVIDER_ALIASES: Record<string, string> = {
  'minimax-global': 'minimax',
}

/**
 * 提交时决定使用哪个 piAuthProvider。
 * 在 Pi API key 流程中，即使是 Custom 预设，也需要给 Pi SDK 一个 provider 提示，
 * 用于决定如何格式化鉴权请求头。
 */
export function resolvePiAuthProviderForSubmit(
  activePreset: PresetKey,
  lastNonCustomPreset: PresetKey | null
): string | undefined {
  if (activePreset === 'custom') {
    // Custom 情况下，优先沿用上一个非 Custom 预设的 provider；否则默认 anthropic。
    const resolved = lastNonCustomPreset && lastNonCustomPreset !== 'custom'
      ? lastNonCustomPreset
      : 'anthropic'
    return PI_AUTH_PROVIDER_ALIASES[resolved] ?? resolved
  }

  return PI_AUTH_PROVIDER_ALIASES[activePreset] ?? activePreset
}

/**
 * 当用户在 Base URL 输入框里改动 URL 时，决定 activePreset 与 lastNonCustomPreset 的下一状态。
 * 如果输入框内容匹配到某个已知预设的 URL，就切到该预设；否则保持或进入 custom。
 */
export function resolvePresetStateForBaseUrlChange(params: {
  matchedPreset: PresetKey
  activePreset: PresetKey
  activePresetHasEmptyUrl: boolean
  lastNonCustomPreset: PresetKey | null
}): { activePreset: PresetKey; lastNonCustomPreset: PresetKey | null } {
  const { matchedPreset, activePreset, activePresetHasEmptyUrl, lastNonCustomPreset } = params

  if (matchedPreset !== 'custom') {
    return {
      activePreset: matchedPreset,
      lastNonCustomPreset: matchedPreset,
    }
  }

  if (activePresetHasEmptyUrl) {
    return {
      activePreset,
      lastNonCustomPreset,
    }
  }

  return {
    activePreset: 'custom',
    lastNonCustomPreset,
  }
}

/**
 * 提交时解析 customEndpoint 与 piAuthProvider。
 *
 * 分三条分支：
 *  - 品牌化的 OpenAI 兼容预设（如 Manifest）→ 固定使用 openai-completions
 *  - 带 Base URL 的通用 custom 预设          → 尊重用户选择的协议开关
 *  - 其他情况                                 → 不带 customEndpoint，仅透传 piAuth
 */
export function resolveCustomEndpointPayload(params: {
  activePreset: PresetKey
  baseUrl: string
  customApi: CustomEndpointApi
  brandedOpenAiCompatPresets: ReadonlySet<string>
  fallbackPiAuthProvider: string | undefined
}): {
  customEndpoint: CustomEndpointConfig | undefined
  piAuthProvider: string | undefined
} {
  const { activePreset, baseUrl, customApi, brandedOpenAiCompatPresets, fallbackPiAuthProvider } = params

  const isBrandedOpenAiCompat = brandedOpenAiCompatPresets.has(activePreset) && !!baseUrl
  const isCustomEndpoint = (activePreset === 'custom' && !!baseUrl) || isBrandedOpenAiCompat
  const effectiveApi: CustomEndpointApi = isBrandedOpenAiCompat ? 'openai-completions' : customApi

  return {
    customEndpoint: isCustomEndpoint ? { api: effectiveApi } : undefined,
    piAuthProvider: isCustomEndpoint
      ? (effectiveApi === 'anthropic-messages' ? 'anthropic' : 'openai')
      : fallbackPiAuthProvider,
  }
}
