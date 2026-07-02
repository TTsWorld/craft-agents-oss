/**
 * Dynamic API Tool Factory（动态 API Tool 工厂）
 *
 * 为每个 API 配置创建一个灵活的 MCP tool。
 * 每个 tool 接受 { path, method, params }，并自动注入认证信息。
 *
 * 相关概念：
 * - MCP：Model Context Protocol，让 LLM agent 调用外部工具/数据的协议。
 * - tool：agent 可调用的函数；这里用 @anthropic-ai/claude-agent-sdk 的 `tool()` 创建。
 * - handler：tool 被调用时执行的函数，类似 Go http.Handler 处理请求。
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ApiConfig } from './types.ts';
import { debug } from '../utils/debug.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import { MAX_DOWNLOAD_SIZE, formatBytes } from '../utils/binary-detection.ts';
import type { ApiCredential, BasicAuthCredential } from './credential-manager.ts';
import { isMultiHeaderCredential } from './credential-manager.ts';

// 重新导出，方便其他模块使用
export type { ApiCredential, BasicAuthCredential } from './credential-manager.ts';

/**
 * 为 bearer 风格认证构造 Authorization 头值。
 *
 * 支持三种情况：
 * - `authScheme: undefined` → 默认 "Bearer {token}"
 * - `authScheme: "Token"` → "Token {token}"（自定义前缀）
 * - `authScheme: ""` → "{token}"（无前缀，某些 GraphQL 或内部服务期望原始 token）
 *
 * 空字符串场景用于一些期望原始 JWT/token、不需要 "Bearer" 前缀的 API。
 *
 * @param authScheme - 认证方案前缀（undefined 默认 "Bearer"，空字符串表示无前缀）
 * @param token - 认证 token
 * @returns 完整的 Authorization 头值
 */
export function buildAuthorizationHeader(authScheme: string | undefined, token: string): string {
  // 用空值合并运算符 ??：只有 undefined/null 才回退为 'Bearer'，空字符串 "" 会保留
  const scheme = authScheme ?? 'Bearer';
  // scheme 为空字符串时只返回 token，否则加前缀
  return scheme ? `${scheme} ${token}` : token;
}

/**
 * API 凭证来源 —— 可以是静态凭证值，也可以是按需解析的函数。
 *
 * 静态形式：在创建 tool 时捕获的字符串 / BasicAuthCredential / MultiHeaderCredential。
 * 用于老路径和公开 API（空字符串）。
 *
 * Getter 形式：每次请求前调用。支持两种返回：
 *   - `() => Promise<string>` —— OAuth / renew-endpoint source，永远返回非空 access token。
 *   - `() => Promise<ApiCredential | null>` —— 非 OAuth API source，每次从凭证库读最新凭证。
 *     用户还没提供凭证时返回 null。
 *
 * 使用 getter 后，会话中更新凭证不需要重启 tool 进程就能生效。
 */
export type ApiCredentialSource =
  | ApiCredential
  | (() => Promise<string>)
  | (() => Promise<ApiCredential | null>);

/**
 * 类型守卫：判断 credential 是否是 BasicAuthCredential
 */
function isBasicAuthCredential(cred: ApiCredential): cred is BasicAuthCredential {
  return typeof cred === 'object' && cred !== null && 'username' in cred && 'password' in cred;
}

/**
 * 类型守卫：判断凭证来源是否是 token getter 函数。
 * 两种返回形状（Promise<string> 和 Promise<ApiCredential | null>）
 * 在这里都会流经同一调用点，由调用方归一化处理。
 */
function isTokenGetter(
  cred: ApiCredentialSource
): cred is () => Promise<string> | Promise<ApiCredential | null> {
  return typeof cred === 'function';
}

/** Summarize 回调类型 —— 通常是 agent.runMiniCompletion.bind(agent) */
export type SummarizeCallback = (prompt: string) => Promise<string | null>;


/**
 * 为 API 请求构造请求头，注入认证信息和默认请求头
 */
export function buildHeaders(
  auth: ApiConfig['auth'],
  credential: ApiCredential,
  defaultHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // 合并默认请求头（例如 beta feature flags）
    ...defaultHeaders,
  };

  // type='none' 或没有 auth 时直接返回
  if (!auth || auth.type === 'none') {
    return headers;
  }

  // basic auth 需要 username:password 凭证
  if (auth.type === 'basic') {
    if (isBasicAuthCredential(credential)) {
      const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  // header 认证（支持单 header 和多 header）
  if (auth.type === 'header') {
    // 多 header：凭证是 { headerName: value, ... }
    if (isMultiHeaderCredential(credential)) {
      Object.assign(headers, credential);
    }
    // 单 header：保持原有行为
    else if (typeof credential === 'string' && credential) {
      headers[auth.headerName || 'x-api-key'] = credential;
    }
    return headers;
  }

  // 其他类型使用字符串凭证（API key/token）
  const apiKey = typeof credential === 'string' ? credential : '';
  if (!apiKey) {
    return headers;
  }

  if (auth.type === 'bearer') {
    headers['Authorization'] = buildAuthorizationHeader(auth.authScheme, apiKey);
  }
  // query 类型在 buildUrl 中处理

  return headers;
}

/**
 * 构造完整 API 请求 URL
 */
function buildUrl(
  baseUrl: string,
  path: string,
  method: string,
  params: Record<string, unknown> | undefined,
  auth: ApiConfig['auth'],
  credential: ApiCredential
): string {
  // 规范化：去掉 baseUrl 末尾的 /，并保证 path 以 / 开头
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let url = `${normalizedBase}${normalizedPath}`;

  // query 参数认证（仅对字符串凭证）
  const apiKey = typeof credential === 'string' ? credential : '';
  if (auth?.type === 'query' && auth.queryParam && apiKey) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}${auth.queryParam}=${encodeURIComponent(apiKey)}`;
  }

  // GET 请求的 params 放到查询字符串
  if (method === 'GET' && params && Object.keys(params).length > 0) {
    const urlParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        // 数组和对象序列化为 JSON 字符串
        if (typeof value === 'object') {
          urlParams.append(key, JSON.stringify(value));
        } else {
          urlParams.append(key, String(value));
        }
      }
    }
    const queryString = urlParams.toString();
    if (queryString) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${queryString}`;
    }
  }

  return url;
}

/**
 * 从 API 配置生成 tool 描述。
 *
 * 这个描述会随每次请求发给 LLM，所以尽量精简，
 * 把端点细节指向 `sources/{slug}/guide.md`。
 * Agent 的 PrerequisiteManager 会在调用 tool 前强制 Read guide，
 * 因此 guide 一定会在模型调用前进入上下文窗口 —— 这里再复制一份就是浪费，
 * 也是 #683 类 provider 拒绝的原因（guide.md 很大时）。
 *
 * 仅导出给单元测试使用；对外视为内部实现。
 */
export function buildToolDescription(config: ApiConfig): string {
  // config.name 就是 source slug（由 SourceServerBuilder.buildApiConfig 设置）
  let desc = `Make authenticated requests to the ${config.name} API (${config.baseUrl}).\n\n`;
  desc += `Authentication is handled automatically — pass path, method, and params.\n`;
  desc += `For non-JSON request bodies, use params: { _rawBody: "raw content", _contentType: "text/plain" }. The _rawBody value is sent as-is without JSON encoding.\n\n`;
  desc += `**Before the first call, Read the source guide at sources/${config.name}/guide.md** — `;
  desc += `it documents available endpoints, required params, and any quirks. The Read is required before the first call (enforced) and again after compaction.\n\n`;
  desc += `**Binary responses** (PDFs, images, archives) are auto-saved to the session downloads folder; reference the returned path when telling the user about downloaded files.`;

  if (config.docsUrl) {
    desc += `\n\nOfficial docs: ${config.docsUrl}`;
  }

  return desc;
}

/**
 * 为一个 API 配置创建单个灵活的 MCP tool。
 * tool 接受 { path, method, params }，自动处理认证。
 *
 * @param config - 包含文档的 API 配置
 * @param credential - API 凭证来源：API key/token 字符串、BasicAuthCredential、
 *                     公开 API 空字符串，或 OAuth token 刷新异步函数
 * @param sessionPath - 可选：用于保存大响应的会话文件夹路径
 * @returns 可加入 MCP server 的 SDK tool
 */
export function createApiTool(
  config: ApiConfig,
  credential: ApiCredentialSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
) {
  const toolName = `api_${config.name}`;
  debug(`[api-tools] Creating flexible tool: ${toolName}`);

  const description = buildToolDescription(config);

  return tool(
    toolName,
    description,
    {
      path: z.string().describe('API endpoint path, e.g., "/search" or "/v1/completions"'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('HTTP method - check documentation for correct method per endpoint'),
      params: z.record(z.string(), z.unknown()).optional().describe('Request body (POST/PUT/PATCH) or query parameters (GET). For non-JSON bodies, pass { _rawBody: "raw string content", _contentType: "text/plain" } — _rawBody is sent as-is without JSON encoding, _contentType defaults to text/plain if omitted'),
      _intent: z.string().optional().describe('REQUIRED: Describe what you are trying to accomplish with this API call (1-2 sentences)'),
    },
    async (args) => {
      const { path, method, params, _intent } = args;

      try {
        // 解析凭证 —— 如果是 getter，调用它拿到最新凭证。
        // null 表示凭证库里没有这个 source 的凭证，归一化为空字符串；
        // buildHeaders / buildUrl 会把空字符串视为“无认证”，让上游 API 自己返回 401。
        const rawCredential = isTokenGetter(credential)
          ? await credential()
          : credential;
        const resolvedCredential: ApiCredential = rawCredential ?? '';

        const url = buildUrl(config.baseUrl, path, method, params, config.auth, resolvedCredential);
        const headers = buildHeaders(config.auth, resolvedCredential, config.defaultHeaders);

        debug(`[api-tools] ${config.name}: ${method} ${url}`);

        const fetchOptions: RequestInit = {
          method,
          headers,
        };

        // 非 GET 请求添加 body
        if (method !== 'GET' && params && Object.keys(params).length > 0) {
          // 通过 _rawBody 支持纯文本 body（例如期望 plain text 的端点）
          if (typeof params._rawBody === 'string') {
            fetchOptions.body = params._rawBody;
            (fetchOptions.headers as Record<string, string>)['Content-Type'] =
              typeof params._contentType === 'string' ? params._contentType : 'text/plain';
            debug(`[api-tools] ${config.name}: raw body (${(fetchOptions.headers as Record<string, string>)['Content-Type']}): ${params._rawBody.substring(0, 200)}`);
          } else {
            fetchOptions.body = JSON.stringify(params);
          }
        }

        debug(`[api-tools] ${config.name}: headers=${JSON.stringify(fetchOptions.headers)}, bodyLength=${fetchOptions.body ? String(fetchOptions.body).length : 0}`);

        const response = await fetch(url, fetchOptions);

        // 防止 OOM：在加载到内存前拒绝超大响应
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          if (!isNaN(size) && size > MAX_DOWNLOAD_SIZE) {
            return {
              content: [{
                type: 'text' as const,
                text: `Response too large: ${formatBytes(size)} exceeds ${formatBytes(MAX_DOWNLOAD_SIZE)} limit. Use a streaming download tool for large files.`,
              }],
              isError: true,
            };
          }
        }

        // 以原始 buffer 加载响应 —— guardLargeResult 负责二进制检测
        const buffer = Buffer.from(await response.arrayBuffer());

        // 先处理错误响应（错误通常是文本）
        if (!response.ok) {
          const text = buffer.toString('utf-8');
          debug(`[api-tools] ${config.name} error ${response.status}: ${text.substring(0, 200)}`);
          return {
            content: [{
              type: 'text' as const,
              text: `API Error ${response.status}: ${text}`,
            }],
            isError: true,
          };
        }

        // 集中处理二进制检测 + 大响应保存
        if (sessionPath) {
          const guarded = await guardLargeResult(buffer, {
            sessionPath,
            toolName: `api_${config.name}`,
            input: params,
            intent: _intent,
            summarize,
          });
          if (guarded) {
            return { content: [{ type: 'text' as const, text: guarded }] };
          }
        }

        return { content: [{ type: 'text' as const, text: buffer.toString('utf-8') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        debug(`[api-tools] ${config.name} request failed: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Request failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * 用单个灵活 API tool 创建一个进程内 MCP server。
 *
 * @param config - API 配置
 * @param credential - API 凭证来源：API key/token 字符串、BasicAuthCredential、
 *                     公开 API 空字符串，或 OAuth token 刷新异步函数
 * @param sessionPath - 可选：用于保存大响应的会话文件夹路径
 * @returns 可传给 query() 的 SDK MCP server
 */
export function createApiServer(
  config: ApiConfig,
  credential: ApiCredentialSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
): ReturnType<typeof createSdkMcpServer> {
  debug(`[api-tools] Creating server for ${config.name}${sessionPath ? ` (session: ${sessionPath})` : ''}`);

  const apiTool = createApiTool(config, credential, sessionPath, summarize);

  return createSdkMcpServer({
    name: `api_${config.name}`,
    version: '1.0.0',
    tools: [apiTool],
  });
}
