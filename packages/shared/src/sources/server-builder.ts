/**
 * SourceServerBuilder
 *
 * 根据 LoadedSource 对象构建 MCP/API server 配置。
 * 本模块负责 URL 规范和 server 配置创建，**不**负责获取凭证 —— 凭证由调用方传入。
 *
 * 这是把 SourceService 里的 server 构建逻辑拆出来后的结果：
 * - SourceCredentialManager：负责凭证
 * - SourceServerBuilder：负责 server 配置
 */

import type { LoadedSource, ApiConfig } from './types.ts';
import { isMultiHeaderCredential, type ApiCredential } from './credential-manager.ts';
import { isSourceUsable } from './storage.ts';
import { createApiServer, type SummarizeCallback } from './api-tools.ts';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { debug } from '../utils/debug.ts';

/**
 * server 构建失败时的标准错误信息。
 * 用常量代替硬编码字符串，方便统一匹配。
 */
export const SERVER_BUILD_ERRORS = {
  AUTH_REQUIRED: 'Authentication required',
  TOKEN_EXPIRED: 'Token expired',
  CREDENTIALS_NEEDED: 'Credentials needed',
} as const;

/**
 * 与 Claude Agent SDK 兼容的 MCP server 配置。
 * 支持 HTTP/SSE（远程）和 stdio（本地子进程）两种传输。
 */
export type McpServerConfig =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

/**
 * 已预加载凭证的 source
 */
export interface SourceWithCredential {
  source: LoadedSource;
  /** MCP source 的 token，或 API source 的 ApiCredential */
  token?: string | null;
  credential?: ApiCredential | null;
}

/**
 * 从 source 构建 server 的结果
 */
export interface BuiltServers {
  /** 以 source slug 为 key 的 MCP server 配置 */
  mcpServers: Record<string, McpServerConfig>;
  /** 以 source slug 为 key 的进程内 API server */
  apiServers: Record<string, ReturnType<typeof createSdkMcpServer>>;
  /** 构建失败的 source（缺少认证等） */
  errors: Array<{ sourceSlug: string; error: string }>;
}

/**
 * SourceServerBuilder - 从 source 构建 server 配置
 *
 * 用法示例：
 * ```typescript
 * const builder = new SourceServerBuilder();
 *
 * // 构建单个 MCP server 配置
 * const mcpConfig = builder.buildMcpServer(source, token);
 *
 * // 从多个带凭证的 source 构建全部 server
 * const { mcpServers, apiServers, errors } = await builder.buildAll([
 *   { source, token: 'abc123' },
 *   { source: apiSource, credential: 'api-key' },
 * ]);
 * ```
 */
export class SourceServerBuilder {
  /**
   * 从 source 构建 MCP server 配置
   *
   * @param source - source 配置
   * @param token - 认证 token（公开/stdio source 为 null）
   * @param credential - 来自凭证库的多 header 凭证（未设置时为 null）
   */
  buildMcpServer(source: LoadedSource, token: string | null, credential?: ApiCredential | null): McpServerConfig | null {
    if (source.config.type !== 'mcp' || !source.config.mcp) {
      return null;
    }

    const mcp = source.config.mcp;

    // stdio 传输（本地子进程 server）
    if (mcp.transport === 'stdio') {
      if (!mcp.command) {
        debug(`[SourceServerBuilder] Stdio source ${source.config.slug} missing command`);
        return null;
      }
      return {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
      };
    }

    // HTTP/SSE 传输（远程 server）
    if (!mcp.url) {
      debug(`[SourceServerBuilder] HTTP/SSE source ${source.config.slug} missing URL`);
      return null;
    }

    const url = normalizeMcpUrl(mcp.url);

    const config: McpServerConfig = {
      type: mcp.transport === 'sse' ? 'sse' : 'http',
      url,
    };

    // 分层合并请求头，优先级递增：
    // 1. config 里的静态 headers（非密钥）
    // 2. 凭证库里的 headerNames（密钥类 API key）
    // 3. Authorization bearer token（OAuth/bearer 认证，最高优先级）
    let mergedHeaders: Record<string, string> = {};

    // 1. 静态 headers（例如 X-Custom-Header: value）
    if (mcp.headers) {
      mergedHeaders = { ...mcp.headers };
    }

    // 2. 凭证库 headers（例如凭证库里的 X-API-Key）
    if (credential && isMultiHeaderCredential(credential)) {
      mergedHeaders = { ...mergedHeaders, ...credential };
    }

    // 3. 认证 token（最高优先级 —— OAuth/bearer 覆盖其他头）
    if (mcp.authType !== 'none') {
      if (token) {
        mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${token}` };
      } else if (source.config.isAuthenticated) {
        // source 声称已认证但 token 缺失，需要重新认证
        debug(`[SourceServerBuilder] Source ${source.config.slug} needs re-authentication`);
        return null;
      }
    }

    if (Object.keys(mergedHeaders).length > 0) {
      (config as { headers?: Record<string, string> }).headers = mergedHeaders;
    }

    return config;
  }

  /**
   * 从 source 构建 API server
   *
   * @param source - source 配置
   * @param credential - API 凭证（公开 API 为 null）
   * @param getToken - OAuth API 的 token getter（支持自动刷新）
   * @param sessionPath - 可选：用于保存大响应的会话文件夹路径
   * @param getCredential - 非 OAuth API source 的每次请求凭证 getter
   */
  async buildApiServer(
    source: LoadedSource,
    credential: ApiCredential | null,
    getToken?: () => Promise<string>,
    sessionPath?: string,
    summarize?: SummarizeCallback,
    getCredential?: () => Promise<ApiCredential | null>
  ): Promise<ReturnType<typeof createSdkMcpServer> | null> {
    if (source.config.type !== 'api') return null;
    if (!source.config.api) {
      debug(`[SourceServerBuilder] API source ${source.config.slug} missing api config`);
      return null;
    }

    const apiConfig = source.config.api;
    const authType = apiConfig.authType;
    const provider = source.config.provider;

    // Google API：用支持自动刷新的 token getter
    // 直接检查 isAuthenticated 是安全的 —— Google OAuth 必须认证
    if (provider === 'google') {
      if (!source.config.isAuthenticated || !getToken) {
        debug(`[SourceServerBuilder] Google API source ${source.config.slug} not authenticated`);
        return null;
      }
      debug(`[SourceServerBuilder] Building Google API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      // 传入 token getter：每次请求前调用，获取最新 token（过期会自动刷新）
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // Slack API：用支持自动刷新的 token getter
    if (provider === 'slack') {
      if (!source.config.isAuthenticated || !getToken) {
        debug(`[SourceServerBuilder] Slack API source ${source.config.slug} not authenticated`);
        return null;
      }
      debug(`[SourceServerBuilder] Building Slack API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // 通用 OAuth API：用支持自动刷新的 token getter
    // 顺序注意：provider-specific 检查（google、slack）在前面
    if (authType === 'oauth') {
      if (!source.config.isAuthenticated || !getToken) {
        debug(`[SourceServerBuilder] Generic OAuth source ${source.config.slug} not authenticated`);
        return null;
      }
      debug(`[SourceServerBuilder] Building generic OAuth API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // 公开 API（无需认证）可直接使用
    if (authType === 'none') {
      debug(`[SourceServerBuilder] Building public API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, '', sessionPath, summarize);
    }

    // renew-endpoint source 用 token getter 自动续期，而不是静态凭证
    if (getToken && apiConfig.renewEndpoint) {
      debug(`[SourceServerBuilder] Building API server for ${source.config.slug} (auth: ${authType}, renew-endpoint)`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // API key/bearer/header/query/basic 认证。
    //
    // 如果提供了每次请求的凭证 getter，就用它，这样用户在会话中更新凭证
    //（例如通过 source_credential_prompt 粘贴了新 JWT）后，下一次 tool 调用就能生效，
    // 不需要重启会话。
    //
    // 之前 createApiTool 捕获的是构建时刻的静态字符串快照，导致进程内 tool 一直用旧 token；
    // 改用 getter 后每次请求都会从凭证库读最新值。
    if (getCredential) {
      debug(`[SourceServerBuilder] Building API server for ${source.config.slug} (auth: ${authType}, per-request credential)`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, getCredential, sessionPath, summarize);
    }

    // 兜底：没有 getter —— 保持老的静态凭证行为
    //（测试和不传 getter 的调用方仍在用）
    if (!credential) {
      debug(`[SourceServerBuilder] API source ${source.config.slug} needs credentials`);
      return null;
    }

    debug(`[SourceServerBuilder] Building API server for ${source.config.slug} (auth: ${authType}, static credential)`);
    const config = this.buildApiConfig(source);
    return createApiServer(config, credential, sessionPath, summarize);
  }

  /**
   * 从 LoadedSource 构建 ApiConfig
   */
  buildApiConfig(source: LoadedSource): ApiConfig {
    const api = source.config.api!;

    const config: ApiConfig = {
      name: source.config.slug,
      baseUrl: api.baseUrl,
      // documentation 不再内联到 tool 描述里（见 #683 和 api-tools.ts:buildToolDescription）。
      // 模型通过 prerequisite-manager 强制 Read guide.md 来获取端点细节。
      defaultHeaders: api.defaultHeaders,
    };

    // 映射认证类型
    switch (api.authType) {
      case 'bearer':
        config.auth = { type: 'bearer', authScheme: api.authScheme ?? 'Bearer' };
        break;
      case 'header':
        config.auth = { type: 'header', headerName: api.headerName || 'x-api-key' };
        break;
      case 'query':
        config.auth = { type: 'query', queryParam: api.queryParam || 'api_key' };
        break;
      case 'basic':
        config.auth = { type: 'basic' };
        break;
      case 'oauth':
        // 通用 OAuth token 以 Bearer 形式发送
        config.auth = { type: 'bearer', authScheme: api.authScheme ?? 'Bearer' };
        break;
      case 'none':
      default:
        config.auth = { type: 'none' };
    }

    return config;
  }

  /**
   * 为所有已启用的 source 构建 MCP/API server
   *
   * @param sourcesWithCredentials - 带预加载凭证的 source 列表
   * @param getTokenForSource - 为 OAuth / renew-endpoint source 提供 token getter 的函数
   * @param sessionPath - 可选：用于保存大 API 响应的会话文件夹路径
   * @param summarize - 可选：大响应摘要回调
   * @param getCredentialForSource - 为非 OAuth API source 提供每次请求凭证 getter 的函数。
   *   传入后，进程内 tool 每次调用都会从凭证库读最新凭证，而不是缓存旧快照 ——
   *   这是会话中更新凭证能生效的关键。
   */
  async buildAll(
    sourcesWithCredentials: SourceWithCredential[],
    getTokenForSource?: (source: LoadedSource) => (() => Promise<string>) | undefined,
    sessionPath?: string,
    summarize?: SummarizeCallback,
    getCredentialForSource?: (source: LoadedSource) => (() => Promise<ApiCredential | null>) | undefined
  ): Promise<BuiltServers> {
    const mcpServers: Record<string, McpServerConfig> = {};
    const apiServers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
    const errors: BuiltServers['errors'] = [];

    for (const { source, token, credential } of sourcesWithCredentials) {
      if (!isSourceUsable(source)) continue;

      try {
        if (source.config.type === 'mcp') {
          const config = this.buildMcpServer(source, token ?? null, credential);
          if (config) {
            debug(`[SourceServerBuilder] Built MCP server for ${source.config.slug}`);
            mcpServers[source.config.slug] = config;
          } else if (source.config.mcp?.transport !== 'stdio' && source.config.mcp?.authType !== 'none') {
            // 只对需要认证的 HTTP/SSE source 报告认证错误
            // stdio source 不需要认证
            debug(`[SourceServerBuilder] MCP server ${source.config.slug} needs auth`);
            errors.push({
              sourceSlug: source.config.slug,
              error: SERVER_BUILD_ERRORS.AUTH_REQUIRED,
            });
          }
        } else if (source.config.type === 'api') {
          const getToken = getTokenForSource?.(source);
          const getCredential = getCredentialForSource?.(source);
          const server = await this.buildApiServer(
            source,
            credential ?? null,
            getToken,
            sessionPath,
            summarize,
            getCredential
          );
          if (server) {
            apiServers[source.config.slug] = server;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug(`[SourceServerBuilder] Failed to build server for ${source.config.slug}: ${message}`);
        errors.push({ sourceSlug: source.config.slug, error: message });
      }
    }

    return { mcpServers, apiServers, errors };
  }
}

/**
 * 规范化 MCP URL
 * - 去掉末尾的斜杠
 * - 保留用户配置的路径，不自动追加 /mcp
 */
export function normalizeMcpUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// 单例实例
let instance: SourceServerBuilder | null = null;

/**
 * 获取共享的 SourceServerBuilder 实例
 */
export function getSourceServerBuilder(): SourceServerBuilder {
  if (!instance) {
    instance = new SourceServerBuilder();
  }
  return instance;
}
