/**
 * ChatGPT 后端搜索 provider——面向 ChatGPT Plus / OpenAI OAuth 用户。
 *
 * 使用与公开 OpenAI API 相同的 Responses API 格式，但请求的是
 * ChatGPT 后端 endpoint，它接受 OAuth access token 而非 API key。
 *
 * 鉴权流程与 Pi SDK 的 `openai-codex-responses.js` 一致：
 *   - Bearer token：OAuth access token
 *   - chatgpt-account-id：从 JWT 的 claims 里提取
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';
import { parseResponsesApiResults, type ResponsesApiResponse } from './responses-api-parser.ts';

/**
 * Codex 后端请求契约（搜索路径）：
 * - model: gpt-5.3-codex
 * - store: false
 * - stream: true（后端可能返回 JSON 或 SSE）
 * - instructions + tool_choice + text.verbosity
 * - OpenAI-Beta: responses=experimental 头
 *
 * 如果这个 payload 有变更，请同步更新：
 *   - ./chatgpt.test.ts
 *   - ../SEARCH_PAYLOAD_CONTRACT.md
 */
const DEFAULT_SEARCH_MODEL = 'gpt-5.3-codex';
const API_BASE = 'https://chatgpt.com/backend-api/codex';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const ERROR_TEXT_LIMIT = 600;
const SEARCH_INSTRUCTIONS = 'You are a web search assistant. Return concise, factual search results with source citations when available.';
const SEARCH_TEXT_VERBOSITY = 'medium';

interface SearchAttempt {
  toolType: 'web_search' | 'web_search_preview';
  label: string;
}

const SEARCH_ATTEMPTS: SearchAttempt[] = [
  { toolType: 'web_search', label: 'web_search' },
  { toolType: 'web_search_preview', label: 'web_search_preview' },
];

/**
 * 从 ChatGPT OAuth access token (JWT) 里提取 `chatgpt_account_id`。
 * token 格式错误或 claim 缺失时返回 null。
 */
export function extractChatGptAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1]!));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;

    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

export class ChatGPTBackendSearchProvider implements WebSearchProvider {
  name = 'ChatGPT';

  constructor(
    private accessToken: string,
    private accountId: string,
    private options?: { model?: string },
  ) {}

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const attemptErrors: string[] = [];

    for (const attempt of SEARCH_ATTEMPTS) {
      const requestBody = {
        model: this.options?.model || DEFAULT_SEARCH_MODEL,
        store: false,
        stream: true,
        instructions: SEARCH_INSTRUCTIONS,
        tools: [{ type: attempt.toolType }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        text: { verbosity: SEARCH_TEXT_VERBOSITY },
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Search the web for: ${query}\n\nReturn the top ${count} results with title, URL, and a brief description.`,
              },
            ],
          },
        ],
      };

      const requestFingerprint = buildRequestFingerprint(requestBody);
      const hasMoreAttempts = attempt !== SEARCH_ATTEMPTS[SEARCH_ATTEMPTS.length - 1];

      const response = await fetch(`${API_BASE}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          'chatgpt-account-id': this.accountId,
          'OpenAI-Beta': 'responses=experimental',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30_000),
      });

      const contentType = response.headers.get('content-type') || 'unknown';

      if (response.ok) {
        try {
          const data = await parseResponsePayload(response);
          return parseResponsesApiResults(data, query, count);
        } catch (parseError) {
          const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
          attemptErrors.push(
            `${attempt.label} parse failed [${requestFingerprint}, content-type=${contentType}]: ${compactErrorText(parseMessage)}`,
          );

          if (hasMoreAttempts) {
            continue;
          }

          throw new Error(`ChatGPT search failed: ${attemptErrors.join('; ')}`);
        }
      }

      const errorText = await response.text();
      const compactError = compactErrorText(errorText);
      attemptErrors.push(
        `${attempt.label} failed (HTTP ${response.status}) [${requestFingerprint}, content-type=${contentType}]: ${compactError}`,
      );

      // 仅在疑似 schema/tool 不兼容（400）时重试。
      const canRetry = response.status === 400;
      if (!(canRetry && hasMoreAttempts)) {
        throw new Error(`ChatGPT search failed: ${attemptErrors.join('; ')}`);
      }
    }

    throw new Error(`ChatGPT search failed: ${attemptErrors.join('; ')}`);
  }
}

async function parseResponsePayload(response: Response): Promise<ResponsesApiResponse> {
  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();

  const looksLikeSse =
    contentType.includes('text/event-stream') ||
    raw.startsWith('event:') ||
    raw.includes('\ndata:') ||
    raw.includes('\n\nevent:');

  if (looksLikeSse) {
    return parseSseResponsePayload(raw);
  }

  try {
    return JSON.parse(raw) as ResponsesApiResponse;
  } catch {
    throw new Error(`ChatGPT search response parse failed: expected JSON or SSE payload, got: ${compactErrorText(raw)}`);
  }
}

function parseSseResponsePayload(sseText: string): ResponsesApiResponse {
  let completed: ResponsesApiResponse | null = null;

  for (const chunk of sseText.split('\n\n')) {
    const dataLines = chunk
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);

    for (const line of dataLines) {
      if (line === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event?.type === 'response.completed' || event?.type === 'response.done') {
        if (event.response && typeof event.response === 'object') {
          completed = event.response as ResponsesApiResponse;
        }
      }
    }
  }

  if (!completed) {
    throw new Error('ChatGPT search stream returned no completed response payload');
  }

  return completed;
}

function buildRequestFingerprint(body: {
  model: string;
  store: boolean;
  stream: boolean;
  tools: Array<{ type: string }>;
  tool_choice: string;
  text?: { verbosity?: string };
}): string {
  const toolType = body.tools[0]?.type || 'unknown';
  const verbosity = body.text?.verbosity || 'unset';

  return `tool=${toolType}, model=${body.model}, store=${String(body.store)}, stream=${String(body.stream)}, tool_choice=${body.tool_choice}, text.verbosity=${verbosity}`;
}

function compactErrorText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Bad Request';
  return normalized.slice(0, ERROR_TEXT_LIMIT);
}
