/**
 * Google 搜索 provider——用 Gemini API 配合原生 Google Search grounding。
 *
 * 发起一次独立的 Gemini API 调用，把 `{ googleSearch: {} }` 作为工具。
 * Gemini API 不允许在同一请求里把 `googleSearch` grounding 和函数调用混用，
 * 因此这里作为旁路调用。
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';

const GROUNDING_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GroundingMetadata {
  groundingChunks?: GroundingChunk[];
  searchEntryPoint?: { renderedContent?: string };
  webSearchQueries?: string[];
}

export class GoogleSearchProvider implements WebSearchProvider {
  name = 'Google';

  constructor(private apiKey: string) {}

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const url = `${API_BASE}/${GROUNDING_MODEL}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ googleSearch: {} }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Search failed (HTTP ${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.length) {
      throw new Error(`Google Search returned no results for "${query}"`);
    }

    // 提取带 grounding 的文本响应
    const text = candidate.content.parts
      .map((p: any) => p.text || '')
      .join('')
      .trim();

    // 从 grounding 元数据里提取来源引用
    const metadata: GroundingMetadata | undefined = candidate.groundingMetadata;
    const chunks = metadata?.groundingChunks?.filter(
      (c: GroundingChunk) => c.web?.uri,
    ) || [];

    if (chunks.length > 0) {
      return chunks.slice(0, count).map((c) => ({
        title: c.web!.title || c.web!.uri!,
        url: c.web!.uri!,
        description: '',
      }));
    }

    // 兜底：把带 grounding 的文本作为单条结果返回
    return [
      {
        title: `Search results for "${query}"`,
        url: '',
        description: text.slice(0, 500),
      },
    ];
  }
}
