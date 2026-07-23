/**
 * 根据用户的 LLM 连接解析最佳 web 搜索 provider。
 *
 * 优先级：
 *   1. provider 原生搜索（OpenAI、ChatGPT、OpenRouter、Google）——质量最好
 *   2. DuckDuckGo——通用兜底，无需 API key
 *
 * 新增兼容 Responses API 的 provider 步骤：
 *   1. 在这里加一个 case，带上 provider 名和 apiBase URL
 *   2. 其余交给 ResponsesApiSearchProvider 处理
 */

import type { WebSearchProvider } from './types.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { ChatGPTBackendSearchProvider, extractChatGptAccountId } from './providers/chatgpt.ts';
import { GoogleSearchProvider } from './providers/google.ts';
import { DDGSearchProvider } from './providers/ddg.ts';

export type SearchProviderCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: string; key?: string; access?: string };

export interface SearchProviderAuthConfig {
  provider?: string;
  credential?: SearchProviderCredential;
}

function getApiKey(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'api_key') return undefined;
  return typeof piAuth.credential.key === 'string' && piAuth.credential.key.length > 0
    ? piAuth.credential.key
    : undefined;
}

function getOAuthAccess(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'oauth') return undefined;
  const access = (piAuth.credential as { access?: string }).access;
  return typeof access === 'string' && access.length > 0 ? access : undefined;
}

/**
 * openai-codex 的 token 可能以两种形态到达：
 *  - oauth.access（旧的/显式 oauth 形态），或
 *  - api_key.key（当前运行时 ChatGPT Plus OAuth bearer token 的形态）
 */
function getOpenAiCodexAccessToken(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.provider !== 'openai-codex') return undefined;
  return getOAuthAccess(piAuth) ?? getApiKey(piAuth);
}

export function resolveSearchProvider(piAuth?: SearchProviderAuthConfig): WebSearchProvider {
  const provider = piAuth?.provider;
  const apiKey = getApiKey(piAuth);
  const openAiCodexAccess = getOpenAiCodexAccessToken(piAuth);

  // 带 API key 的 OpenAI → 标准 Responses API
  if (provider === 'openai' && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://api.openai.com/v1',
      apiKey,
    });
  }

  // ChatGPT Plus（OpenAI OAuth bearer token）→ ChatGPT 后端 endpoint
  // 同时支持 oauth.access 和 api_key.key 两种 token 形态。
  if (provider === 'openai-codex' && openAiCodexAccess) {
    const accountId = extractChatGptAccountId(openAiCodexAccess);
    if (accountId) {
      return new ChatGPTBackendSearchProvider(openAiCodexAccess, accountId);
    }
    // 无法提取 accountId（格式错误/非 JWT token）→ 回退到 DDG
  }

  // OpenRouter → 同样的 Responses API 格式，只是 base URL 不同
  if (provider === 'openrouter' && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey,
      model: 'openai/gpt-4o-mini',
    });
  }

  // Google → 带 Google Search grounding 的 Gemini API
  if (provider === 'google' && apiKey) {
    return new GoogleSearchProvider(apiKey);
  }

  // Vercel AI Gateway 目前未接入 provider 原生搜索路由。
  // 在我们补上显式的 Responses API 映射之前，它有意回退到 DDG。

  // 通用兜底——无需 API key
  return new DDGSearchProvider();
}
