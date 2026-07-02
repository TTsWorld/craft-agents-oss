/**
 * 文件：connection-setup-logic.ts
 * 位置：packages/server-core/src/domain
 * 职责：LLM 连接设置的纯函数逻辑，包括错误解析、输入校验、模板生成、模型校验等。
 *
 * 架构角色：
 *   - 从 ipc.ts 抽离出来，解耦 IPC 与业务规则，方便写单元测试。
 *   - 类似 Go 里把业务逻辑放在 service/usecase 层，不依赖 net/http。
 *
 * Agent 开发关注点：
 *   - LlmConnection 是 Agent 调用大模型的“线路配置”：provider、authType、model 等。
 *   - 本文件处理连接创建阶段，不处理运行时调用。
 */

import type { ModelDefinition } from '@craft-agent/shared/config/models'
import {
  type LlmConnection,
  type CustomEndpointApi,
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  defaultMidStreamBehavior,
} from '@craft-agent/shared/config'

// ============================================================
// 错误解析
// ============================================================

/**
 * 把连接测试返回的错误消息转成面向用户的提示。
 *
 * 类比 Go：类似 errors.Is + switch err.(type) 的错误分类。
 * TS 特性：string 的 includes 判断配合 if 链，是典型的“卫语句”写法。
 */
export function parseTestConnectionError(msg: string): string {
  const lower = msg.toLowerCase()

  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return 'Cannot connect to API server. Check the URL and ensure the server is running.'
  }
  if (lower.includes('no api key found for')) {
    return 'Provider mismatch during setup. Select a provider preset in Craft Agents Backend API Key mode, or use Anthropic API Key mode for arbitrary compatible endpoints.'
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return 'Invalid API key'
  }
  if (lower.includes('404') && lower.includes('model')) {
    return 'Model not found. Check the model name and try again.'
  }
  if (lower.includes('404')) {
    return 'API endpoint not found. Check the URL.'
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'Rate limit exceeded. Please try again.'
  }
  if (lower.includes('403')) {
    return 'API key does not have permission to access this resource'
  }

  return msg.slice(0, 300)
}

/**
 * 校验 Pi 自定义端点测试输入是否合法：
 * 当用户填写了自定义 baseUrl 且 provider 为 pi 时，必须选择 provider preset，
 * 否则后端无法决定把请求路由到哪个 provider。
 *
 * TS 特性：
 *   - `{ provider: 'anthropic' | 'pi' }` 是“字面量联合类型”，比 Go 的 string 枚举更精确。
 *   - 返回类型 `{ valid: true } | { valid: false; error: string }` 是“可辨识联合（discriminated union）”，
 *     调用方用 valid 字段做分支，类似 Go 里的接口 + 类型断言。
 *   - `params.baseUrl?.trim()` 是可选链 + 空字符串判空，比 Go 的 if x != nil && x != "" 更短。
 */
export function validateSetupTestInput(params: {
  provider: 'anthropic' | 'pi'
  baseUrl?: string
  piAuthProvider?: string
}): { valid: true } | { valid: false; error: string } {
  const hasCustomEndpoint = !!params.baseUrl?.trim()
  if (params.provider === 'pi' && hasCustomEndpoint && !params.piAuthProvider) {
    return {
      valid: false,
      error: 'Custom endpoint in Craft Agents Backend mode requires selecting a provider preset. For arbitrary Anthropic-compatible endpoints, use Anthropic API Key mode.',
    }
  }

  return { valid: true }
}

/**
 * 判断 URL 是否指向本地回环地址（localhost / 127.0.0.1 / ::1）。
 *
 * 用途：本地模型（如 Ollama）允许不填 API Key。
 * TS 特性：
 *   - `new URL(...).hostname` 是 Web 标准 API，Node/Bun 都可用。
 *   - `catch { return false }` 省略异常变量，等价 Go 的 `_, ok := ...; !ok`。
 */
export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}

/**
 * 非本地回环端点必须提供 API Key；本地回环可以免 Key。
 */
export function setupTestRequiresApiKey(baseUrl?: string): boolean {
  return !isLoopbackBaseUrl(baseUrl)
}

/**
 * 决定自定义 OpenAI/Anthropic 兼容端点应该如何持久化。
 *
 * 规则：
 *   - 回环地址 + 无密钥 → 本地模型（Ollama、LM Studio），authType 为 none。
 *   - 回环地址 + 有密钥 → 真正的本地 OpenAI 兼容服务（vLLM、LiteLLM），
 *     必须当作远程自定义端点处理，否则运行时 getPiAuth() 返回 null 导致 401。
 *   - 远程地址 → 总是带密钥，并给出 provider hint 以便 UI 显示正确图标。
 *
 * TS 特性：
 *   - `Extract<LlmConnection['authType'], 'none' | 'api_key_with_endpoint'>` 是 TS 类型操作，
 *     从 authType 联合类型中“提取”出指定成员，类似 Go 中从接口集里取子集。
 *   - `input.baseUrl` 后面的 `?` 表示 baseUrl 可能为 undefined。
 */
export function resolveCustomEndpointSetup(input: {
  baseUrl: string | undefined
  credential: string | undefined
  customEndpointApi: CustomEndpointApi
}): {
  authType: Extract<LlmConnection['authType'], 'none' | 'api_key_with_endpoint'>
  name?: 'Local Model'
  piAuthProvider?: 'openai' | 'anthropic'
} {
  const isKeylessLoopback = isLoopbackBaseUrl(input.baseUrl) && !input.credential
  if (isKeylessLoopback) {
    return { authType: 'none', name: 'Local Model' }
  }
  return {
    authType: 'api_key_with_endpoint',
    piAuthProvider: input.customEndpointApi === 'anthropic-messages' ? 'anthropic' : 'openai',
  }
}

// ============================================================
// 内置连接模板
// ============================================================

/**
 * 引导流程中使用的内置连接模板。
 *
 * TS 特性：
 *   - `Record<string, T>` 等价于 `{ [key: string]: T }`，是 TS 提供的映射类型，
 *     类似 Go 的 map[string]T。
 *   - 字段类型里混用具体值和函数，例如 `name: string | ((hasCustomEndpoint: boolean) => string)`，
 *     这是 TS 的“联合类型”，表示“要么是字符串，要么是函数”。
 *     调用处用 typeof 判断后再执行，和 Go 的 interface{} + 类型断言思路一致。
 */
export const BUILT_IN_CONNECTION_TEMPLATES: Record<string, {
  name: string | ((hasCustomEndpoint: boolean) => string)
  providerType: LlmConnection['providerType'] | ((hasCustomEndpoint: boolean) => LlmConnection['providerType'])
  authType: LlmConnection['authType'] | ((hasCustomEndpoint: boolean) => LlmConnection['authType'])
  piAuthProvider?: string
}> = {
  'anthropic-api': {
    name: (h) => h ? 'Custom Anthropic-Compatible' : 'Anthropic (API Key)',
    providerType: (h) => h ? 'pi_compat' : 'anthropic',
    authType: (h) => h ? 'api_key_with_endpoint' : 'api_key',
  },
  'claude-max': {
    name: 'Claude Max',
    providerType: 'anthropic',
    authType: 'oauth',
  },
  'chatgpt-plus': {
    name: 'ChatGPT Plus',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'openai-codex',
  },
  'github-copilot': {
    name: 'GitHub Copilot',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'github-copilot',
  },
  'pi-api-key': {
    name: 'Craft Agents Backend (API Key)',
    providerType: 'pi',
    authType: 'api_key',
    // piAuthProvider 在 setup 阶段根据用户选择的 preset 动态设置
  },
}

// ============================================================
// Pi 认证提供方显示名称
// ============================================================

/**
 * provider key 到人类可读名称的映射表。
 *
 * 类比 Go：`var piAuthProviderDisplayNames = map[string]string{...}`。
 */
const PI_AUTH_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI',
  google: 'Google AI Studio',
  openrouter: 'OpenRouter',
  'azure-openai-responses': 'Azure OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  groq: 'Groq',
  mistral: 'Mistral',
  xai: 'xAI',
  cerebras: 'Cerebras',
  zai: 'z.ai',
  huggingface: 'Hugging Face',
  minimax: 'Minimax',
  'minimax-cn': 'Minimax CN',
  'kimi-coding': 'Kimi (Coding)',
  'vercel-ai-gateway': 'Vercel AI Gateway',
}

/**
 * 获取 Pi auth provider 的显示名；找不到返回 null。
 */
export function piAuthProviderDisplayName(piAuthProvider: string): string | null {
  return PI_AUTH_PROVIDER_DISPLAY_NAMES[piAuthProvider] ?? null
}

// ============================================================
// 连接创建
// ============================================================

/**
 * 根据连接 slug 创建一条 LlmConnection 配置。
 *
 * 逻辑：
 *   - 先精确匹配模板；若失败则去掉末尾数字后缀（anthropic-api-2 → anthropic-api）。
 *   - 模板里的函数字段会根据是否有自定义端点动态选择。
 *   - 自定义连接通过设置 UI 创建，不会走到这里。
 *
 * TS 特性：
 *   - `slug.replace(/-\d+$/, '')` 用正则去掉末尾数字后缀。
 *   - `typeof template.providerType === 'function'` 是运行时类型保护，
 *     配合联合类型让 TS 在分支内推断出准确类型。
 *   - `suffixMatch?.[1]` 中 `?.` 是可选链，`[1]` 是数组索引访问。
 */
export function createBuiltInConnection(slug: string, baseUrl?: string | null): LlmConnection {
  // 先精确匹配模板；失败则去掉末尾数字后缀，用于衍生 slug（如 anthropic-api-2 → anthropic-api）
  const baseSlug = slug.replace(/-\d+$/, '')
  const template = BUILT_IN_CONNECTION_TEMPLATES[slug] ?? BUILT_IN_CONNECTION_TEMPLATES[baseSlug]
  if (!template) {
    throw new Error(`Unknown built-in connection slug: ${slug}. Custom connections should be created through settings.`)
  }

  const hasCustomEndpoint = !!baseUrl
  const providerType = typeof template.providerType === 'function'
    ? template.providerType(hasCustomEndpoint)
    : template.providerType
  const authType = typeof template.authType === 'function'
    ? template.authType(hasCustomEndpoint)
    : template.authType
  let name = typeof template.name === 'function'
    ? template.name(hasCustomEndpoint)
    : template.name

  // 为衍生连接在名称后追加序号（如 anthropic-api-2 → Anthropic (API Key) 2）
  const suffixMatch = slug.match(/-(\d+)$/)
  if (suffixMatch && !BUILT_IN_CONNECTION_TEMPLATES[slug]) {
    name = `${name} ${suffixMatch[1]}`
  }

  return {
    slug,
    name,
    providerType,
    authType,
    models: getDefaultModelsForConnection(providerType, template.piAuthProvider),
    defaultModel: getDefaultModelForConnection(providerType, template.piAuthProvider),
    modelSelectionMode: providerType === 'pi' ? 'automaticallySyncedFromProvider' : undefined,
    piAuthProvider: template.piAuthProvider,
    midStreamBehavior: defaultMidStreamBehavior(providerType),
    createdAt: Date.now(),
  }
}

// ============================================================
// 模型校验
// ============================================================

/**
 * 校验默认模型是否存在于模型列表中。
 *
 * 背景：之前 IPC handler 里直接用 Array.includes() 比较 string 和 ModelDefinition 对象，
 * 对 Pi 连接总是返回 false，因此把这段逻辑抽成纯函数。
 *
 * TS 特性：
 *   - `Array<ModelDefinition | string>` 是“联合类型数组”，元素可能是对象或字符串。
 *   - `typeof m === 'string'` 是类型保护，在 map 回调里把 m 收窄到 string。
 *   - `firstModel!.id` 中的 `!` 是“非空断言”，告诉编译器 firstModel 一定存在；
 *     这里因为前面已经判断 models.length > 0，所以安全。
 */
export function validateModelList(
  models: Array<ModelDefinition | string>,
  defaultModel: string | undefined,
): { valid: boolean; error?: string; resolvedDefaultModel?: string } {
  if (!models || models.length === 0) {
    return { valid: true }
  }

  const modelIds = models.map(m => typeof m === 'string' ? m : m.id)

  if (defaultModel && !modelIds.includes(defaultModel)) {
    return {
      valid: false,
      error: `Default model "${defaultModel}" is not in the provided model list.`,
    }
  }

  if (!defaultModel) {
    const firstModel = models[0]
    const firstModelId = typeof firstModel === 'string' ? firstModel : firstModel!.id
    return {
      valid: true,
      resolvedDefaultModel: firstModelId,
    }
  }

  return { valid: true }
}
