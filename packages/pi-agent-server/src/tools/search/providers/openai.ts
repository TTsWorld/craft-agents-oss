/**
 * Responses API 搜索 provider——适配任何实现了 OpenAI Responses API 格式
 * 且带内置 `web_search` 工具的 endpoint。
 *
 * 支持：
 *   - api.openai.com/v1  (OpenAI 直连)
 *   - openrouter.ai/api/v1  (OpenRouter)
 *   - 任何未来兼容 Responses API 的 endpoint
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';
import { parseResponsesApiResults, type ResponsesApiResponse } from './responses-api-parser.ts';

const DEFAULT_SEARCH_MODEL = 'gpt-4o-mini';

export interface ResponsesApiSearchConfig {
  /** 不带尾斜杠的 base URL（例如 "https://api.openai.com/v1"） */
  apiBase: string;
  /** Authorization 头的 Bearer token */
  apiKey: string;
  /** 搜索调用使用的模型（默认：gpt-4o-mini） */
  model?: string;
  /** 请求中附带的额外头 */
  extraHeaders?: Record<string, string>;
  /** 该 provider 的显示名（默认：由 apiBase 推导） */
  displayName?: string;
}

export class ResponsesApiSearchProvider implements WebSearchProvider {
  name: string;

  constructor(private config: ResponsesApiSearchConfig) {
    this.name = config.displayName || deriveDisplayName(config.apiBase);
  }

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const response = await fetch(`${this.config.apiBase}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.extraHeaders,
      },
      body: JSON.stringify({
        model: this.config.model || DEFAULT_SEARCH_MODEL,
        tools: [{ type: 'web_search' }],
        input: `Search the web for: ${query}\n\nReturn the top ${count} results with title, URL, and a brief description.`,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${this.name} search failed (HTTP ${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as ResponsesApiResponse;
    return parseResponsesApiResults(data, query, count);
  }
}

/**
 * @deprecated 请改用 `ResponsesApiSearchProvider`。
 * 为兼容已有 import 而保留的 re-export。
 */
export const OpenAISearchProvider = ResponsesApiSearchProvider;

function deriveDisplayName(apiBase: string): string {
  if (apiBase.includes('openrouter')) return 'OpenRouter';
  if (apiBase.includes('openai.com')) return 'OpenAI';
  return 'Web Search';
}
