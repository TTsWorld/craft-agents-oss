/**
 * 提供商元数据：用于向用户展示错误提示和恢复操作。
 * 把 provider 标识映射到状态页、控制台地址，方便出错时跳转。
 */

/** 单个 LLM 提供商的展示信息 */
export interface ProviderMetadata {
  /** 展示名称，如 Anthropic、OpenAI */
  name: string
  /** 服务商状态页 URL */
  statusPageUrl?: string
  /** 服务商控制台/计费页 URL */
  dashboardUrl?: string
}

/**
 * 已知提供商的元数据表。
 * key 是 piAuthProvider 值，外加 'anthropic' 表示直连 Anthropic API。
 */
const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  anthropic: {
    name: 'Anthropic',
    statusPageUrl: 'https://status.anthropic.com',
    dashboardUrl: 'https://console.anthropic.com',
  },
  openai: {
    name: 'OpenAI',
    statusPageUrl: 'https://status.openai.com',
    dashboardUrl: 'https://platform.openai.com',
  },
  google: {
    name: 'Google AI Studio',
    statusPageUrl: 'https://status.cloud.google.com',
    dashboardUrl: 'https://aistudio.google.com',
  },
  'amazon-bedrock': {
    name: 'Amazon Bedrock',
    statusPageUrl: 'https://health.aws.amazon.com',
    dashboardUrl: 'https://console.aws.amazon.com/bedrock',
  },
  'google-vertex': {
    name: 'Google Vertex AI',
    statusPageUrl: 'https://status.cloud.google.com',
    dashboardUrl: 'https://console.cloud.google.com/vertex-ai',
  },
  'github-copilot': {
    name: 'GitHub Copilot',
    statusPageUrl: 'https://www.githubstatus.com',
    dashboardUrl: 'https://github.com/settings/copilot',
  },
  openrouter: {
    name: 'OpenRouter',
    dashboardUrl: 'https://openrouter.ai/settings',
  },
  groq: {
    name: 'Groq',
    statusPageUrl: 'https://status.groq.com',
    dashboardUrl: 'https://console.groq.com',
  },
  mistral: {
    name: 'Mistral',
    dashboardUrl: 'https://console.mistral.ai',
  },
  deepseek: {
    name: 'DeepSeek',
    dashboardUrl: 'https://platform.deepseek.com',
  },
  xai: {
    name: 'xAI',
    dashboardUrl: 'https://console.x.ai',
  },
}

/**
 * 根据 provider 类型和可选的 piAuthProvider 查询元数据。
 *
 * 直连 Anthropic：getProviderMetadata('anthropic')
 * 经 Pi 转发：getProviderMetadata('pi', 'openai') 或 getProviderMetadata('pi', 'amazon-bedrock')
 */
export function getProviderMetadata(
  providerType: string,
  piAuthProvider?: string,
): ProviderMetadata | undefined {
  if (providerType === 'anthropic') {
    return PROVIDER_METADATA.anthropic
  }
  if (piAuthProvider) {
    return PROVIDER_METADATA[piAuthProvider]
  }
  return undefined
}

/**
 * 获取提供商的展示名称，找不到时回退为通用文案。
 */
export function getProviderDisplayName(
  providerType: string,
  piAuthProvider?: string,
): string {
  return getProviderMetadata(providerType, piAuthProvider)?.name ?? 'AI provider'
}
