/**
 * SourceCredentialManager
 *
 * Source 的统一凭证管理器。把分散在各处的凭证增删改查、
 * 凭证 ID 解析、过期检查、OAuth 流程等逻辑集中到一起。
 *
 * 它取代了原来散落在以下地方的凭证逻辑：
 * - SourceService.getSourceToken()
 * - SourceService.getApiCredential()
 * - SourceService.getCredentialId()
 * - session-scoped-tools 里的 OAuth 触发
 * - 凭证存储的 IPC handler
 *
 * TS 小知识：
 * - `import { type Xxx }` 是只导入类型，不会生成运行时代码（类似 Go 的 import 类型但编译期擦除）。
 * - `export interface` / `export type` 会被其他模块导入使用。
 * - `cred is MultiHeaderCredential` 这种返回类型叫“类型守卫”。
 */

import {
  inferGoogleServiceFromUrl,
  inferSlackServiceFromUrl,
  inferMicrosoftServiceFromUrl,
  isApiOAuthProvider,
  hasRenewEndpoint,
  type LoadedSource,
  type GoogleService,
  type SlackService,
  type MicrosoftService,
} from './types.ts';
import { buildAuthorizationHeader } from './api-tools.ts';
import type { CredentialId, StoredCredential } from '../credentials/types.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { CraftOAuth, getMcpBaseUrl, prepareMcpOAuth, exchangeMcpOAuth, type OAuthCallbacks, type OAuthTokens } from '../auth/oauth.ts';
import { type OAuthSessionContext } from '../auth/types.ts';
import { OAUTH_RELAY_CALLBACK_URL, wrapPreparedOAuthFlowForRelay } from '../auth/oauth-relay.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult, OAuthProvider } from '../auth/oauth-flow-types.ts';
import {
  startGoogleOAuth,
  prepareGoogleOAuth,
  exchangeGoogleOAuth,
  refreshGoogleToken,
  type GoogleOAuthResult,
  type GoogleOAuthOptions,
} from '../auth/google-oauth.ts';
import {
  startSlackOAuth,
  prepareSlackOAuth,
  exchangeSlackOAuth,
  refreshSlackToken,
  type SlackOAuthResult,
  type SlackOAuthOptions,
} from '../auth/slack-oauth.ts';
import {
  startMicrosoftOAuth,
  prepareMicrosoftOAuth,
  exchangeMicrosoftOAuth,
  refreshMicrosoftToken,
  type MicrosoftOAuthResult,
  type MicrosoftOAuthOptions,
} from '../auth/microsoft-oauth.ts';
import {
  prepareGenericOAuth,
  exchangeGenericOAuth,
  refreshGenericOAuthToken,
} from '../auth/generic-oauth.ts';
import { debug } from '../utils/debug.ts';
import { markSourceAuthenticated, loadSourceConfig, saveSourceConfig } from './storage.ts';

/**
 * 认证尝试结果
 */
export interface AuthResult {
  success: boolean;
  error?: string;
  /** Gmail OAuth 成功时返回用户邮箱 */
  email?: string;
}

/**
 * API 凭证类型：字符串用于简单认证，对象用于 basic auth 或多 header 认证
 */
export interface BasicAuthCredential {
  username: string;
  password: string;
}

/**
 * 多 header 凭证，格式为 Record<string, string>。
 * 用于 Datadog 这类需要多个认证头（DD-API-KEY + DD-APPLICATION-KEY）的 API。
 */
export type MultiHeaderCredential = Record<string, string>;

export type ApiCredential = string | BasicAuthCredential | MultiHeaderCredential;

/**
 * 类型守卫：判断 credential 是否是 MultiHeaderCredential。
 * 返回 true 当：是 Record<string, string> 对象且不是 BasicAuthCredential。
 */
export function isMultiHeaderCredential(cred: ApiCredential): cred is MultiHeaderCredential {
  return (
    typeof cred === 'object' &&
    cred !== null &&
    !('username' in cred && 'password' in cred)
  );
}

/**
 * SourceCredentialManager - source 的统一凭证管理类
 *
 * 用法示例：
 * ```typescript
 * const credManager = new SourceCredentialManager();
 *
 * // 保存凭证
 * await credManager.save(source, { value: 'token123' });
 *
 * // 加载凭证
 * const cred = await credManager.load(source);
 *
 * // 执行 OAuth 流程
 * const result = await credManager.authenticate(source, {
 *   onStatus: (msg) => console.log(msg),
 *   onError: (err) => console.error(err),
 * });
 * ```
 */
export class SourceCredentialManager {
  // 跟踪正在进行的刷新 Promise，防止同一个 source 并发刷新。
  // 这对 Microsoft 很重要：它的 refresh token 会轮换，并发刷新可能导致 token 失效。
  private pendingRefreshes = new Map<string, Promise<string | null>>();

  // ============================================================
  // 核心增删改查
  // ============================================================

  /**
   * 为 source 保存凭证
   */
  async save(source: LoadedSource, credential: StoredCredential): Promise<void> {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    await manager.set(credentialId, credential);
    debug(`[SourceCredentialManager] Saved ${credentialId.type} for ${source.config.slug}`);
  }

  /**
   * 加载 source 的凭证
   *
   * 对 MCP source，会同时尝试 OAuth 和 bearer 两种凭证作为兜底
   *（因为凭证可能通过不同认证模式存进来）。
   */
  async load(source: LoadedSource): Promise<StoredCredential | null> {
    const manager = getCredentialManager();

    // MCP source：同时尝试 OAuth 和 bearer 凭证
    //（stdio 传输不需要凭证）
    if (source.config.type === 'mcp' && source.config.mcp?.transport !== 'stdio' && source.config.mcp?.authType !== 'none') {
      return this.loadMcpCredential(source);
    }

    // API source 且 authType 为 'none' 时，禁止读取共享的 source_apikey 槽位。
    // 'none'、'header'、'query' 在存储时都映射到 source_apikey 以保持兼容；
    // 如果这里读取，source 切到公开/default-header 认证后可能复活旧凭证。
    if (source.config.type === 'api' && source.config.api?.authType === 'none') {
      debug(`[SourceCredentialManager] Skipping credential load for public API source ${source.config.slug}`);
      return null;
    }

    // 其他 source 按 authType 取对应 credential ID
    const credentialId = this.getCredentialId(source);
    const cred = await manager.get(credentialId);

    if (cred) {
      debug(`[SourceCredentialManager] Found ${credentialId.type} for ${source.config.slug}`);
    }

    return cred;
  }

  /**
   * 加载 MCP 凭证，按 OAuth -> bearer 的顺序兜底
   */
  private async loadMcpCredential(source: LoadedSource): Promise<StoredCredential | null> {
    const manager = getCredentialManager();
    const baseId = {
      workspaceId: source.workspaceId,
      sourceId: source.config.slug,
    };

    // 先尝试 OAuth
    const oauthCreds = await manager.get({ type: 'source_oauth', ...baseId });
    if (oauthCreds?.value) {
      debug(`[SourceCredentialManager] Found source_oauth for ${source.config.slug}`);
      return oauthCreds;
    }

    // 再兜底到 bearer
    const bearerCreds = await manager.get({ type: 'source_bearer', ...baseId });
    if (bearerCreds?.value) {
      debug(`[SourceCredentialManager] Found source_bearer for ${source.config.slug}`);
      return bearerCreds;
    }

    debug(`[SourceCredentialManager] No credential found for MCP source ${source.config.slug}`);
    return null;
  }

  /**
   * 删除 source 的凭证
   */
  async delete(source: LoadedSource): Promise<boolean> {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    const deleted = await manager.delete(credentialId);
    if (deleted) {
      debug(`[SourceCredentialManager] Deleted ${credentialId.type} for ${source.config.slug}`);
    }
    return deleted;
  }

  /**
   * 同步删除 source 的凭证。
   * 用于同步的配置保存路径，避免立即重载时读到旧凭证。
   */
  deleteSync(source: LoadedSource): boolean {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    const deleted = manager.deleteSync(credentialId);
    if (deleted) {
      debug(`[SourceCredentialManager] Deleted ${credentialId.type} for ${source.config.slug}`);
    }
    return deleted;
  }

  /**
   * 获取 source 的 token 值（便捷方法）
   * 没有凭证或已过期时返回 null
   */
  async getToken(source: LoadedSource): Promise<string | null> {
    const cred = await this.load(source);
    if (!cred?.value) return null;

    // 检查是否过期
    if (this.isExpired(cred)) {
      debug(`[SourceCredentialManager] Token expired for ${source.config.slug}`);
      return null;
    }

    return cred.value;
  }

  /**
   * 获取 API source 的凭证（处理 basic auth 和多 header 的 JSON 解析）
   */
  async getApiCredential(source: LoadedSource): Promise<ApiCredential | null> {
    const cred = await this.load(source);
    // API 和 MCP 都可能有 headerNames，共用同一套凭证存储模式
    const headerNames = source.config.api?.headerNames || source.config.mcp?.headerNames;
    debug(`[SourceCredentialManager] getApiCredential for ${source.config.slug}: cred.value exists=${!!cred?.value}, headerNames=${JSON.stringify(headerNames)}`);
    if (!cred?.value) return null;

    // 多 header 认证：凭证值是 JSON，key 为 header 名
    // 对 API source（api.headerNames）和 MCP source（mcp.headerNames）都生效
    if (headerNames?.length) {
      debug(`[SourceCredentialManager] Attempting multi-header parse for ${source.config.slug}, raw value length=${cred.value.length}`);
      try {
        const parsed = JSON.parse(cred.value);
        debug(`[SourceCredentialManager] Parsed JSON keys: ${Object.keys(parsed).join(', ')}`);
        // 校验所有需要的 header 都存在
        const hasAllHeaders = headerNames.every((h) => h in parsed);
        debug(`[SourceCredentialManager] hasAllHeaders=${hasAllHeaders}`);
        if (hasAllHeaders) {
          return parsed as MultiHeaderCredential;
        }
      } catch (e) {
        // 不是 JSON，继续走其他认证类型
        debug(`[SourceCredentialManager] JSON parse failed: ${e}`);
      }
    }

    // basic auth：JSON 里含 username/password
    if (source.config.api?.authType === 'basic') {
      try {
        const parsed = JSON.parse(cred.value);
        if (parsed.username && parsed.password) {
          return parsed as BasicAuthCredential;
        }
      } catch {
        // 不是 JSON，按普通凭证处理
      }
    }

    return cred.value;
  }

  // ============================================================
  // 凭证 ID 解析
  // ============================================================

  /**
   * 获取 source 对应的凭证 ID
   *
   * 根据以下因素决定凭证类型：
   * - source 类型（mcp、api、local）
   * - 认证类型（oauth、bearer、header 等）
   */
  getCredentialId(source: LoadedSource): CredentialId {
    const mcp = source.config.mcp;
    const api = source.config.api;

    let type: CredentialId['type'];

    if (source.config.type === 'mcp') {
      type = mcp?.authType === 'bearer' ? 'source_bearer' : 'source_oauth';
    } else if (source.config.type === 'api') {
      // 顺序很重要：先判断 provider-specific，再判断通用 OAuth
      if (isApiOAuthProvider(source.config.provider)) {
        type = 'source_oauth';
      } else if (api?.authType === 'oauth') {
        // 通用 OAuth API source —— 显式配置或自动发现
        type = 'source_oauth';
      } else if (api?.authType === 'bearer') {
        type = 'source_bearer';
      } else if (api?.authType === 'basic') {
        type = 'source_basic';
      } else {
        // header、query 等映射到 apikey 存储
        type = 'source_apikey';
      }
    } else {
      type = 'source_oauth';
    }

    return {
      type,
      workspaceId: source.workspaceId,
      sourceId: source.config.slug,
    };
  }

  // ============================================================
  // 过期检查
  // ============================================================

  /**
   * 判断凭证是否已过期
   */
  isExpired(credential: StoredCredential): boolean {
    if (!credential.expiresAt) return false;
    return Date.now() > credential.expiresAt;
  }

  /**
   * 判断凭证是否需要刷新（距离过期不到 5 分钟）
   */
  needsRefresh(credential: StoredCredential): boolean {
    if (!credential.expiresAt) return false;
    const fiveMinutes = 5 * 60 * 1000;
    return Date.now() > credential.expiresAt - fiveMinutes;
  }

  /**
   * 标记 source 需要重新认证。
   * 在 token 缺失/过期或刷新失败时调用。
   * 更新 config.json，让 UI 显示“需要认证”，并让 agent 拿到正确上下文。
   */
  markSourceNeedsReauth(source: LoadedSource, errorMessage: string): void {
    try {
      const config = loadSourceConfig(source.workspaceRootPath, source.config.slug);
      if (config) {
        config.isAuthenticated = false;
        config.connectionStatus = 'needs_auth';
        config.connectionError = errorMessage;
        saveSourceConfig(source.workspaceRootPath, config);
        debug(`[SourceCredentialManager] Marked ${source.config.slug} as needing re-auth: ${errorMessage}`);
      }
    } catch (error) {
      debug(`[SourceCredentialManager] Failed to mark ${source.config.slug} as needing re-auth:`, error);
    }
  }

  /**
   * 判断 source 是否有有效（未过期）凭证
   */
  async hasValidCredentials(source: LoadedSource): Promise<boolean> {
    const token = await this.getToken(source);
    return token !== null;
  }

  // ============================================================
  // Server-Owned OAuth（Prepare / Exchange）
  // ============================================================

  /**
   * 探测 source 使用的 OAuth provider
   */
  detectProvider(source: LoadedSource): OAuthProvider {
    // 顺序很重要：先判断具体 provider，再兜底通用 OAuth
    if (source.config.provider === 'google') return 'google';
    if (source.config.provider === 'slack') return 'slack';
    if (source.config.provider === 'microsoft') return 'microsoft';
    // 通用 OAuth：显式 oauth 配置块，或 authType 'oauth' 走自动发现
    if (source.config.api?.authType === 'oauth') return 'generic';
    return 'mcp';
  }

  /**
   * 为 source 准备 OAuth 流程（服务端）。
   *
   * 生成 PKCE、state、授权 URL，但不开浏览器、不启动回调服务器。
   * 调用方提供 callbackPort（Electron 本地服务器）或 callbackUrl（WebUI 服务端点）
   * 作为 redirect URI。
   *
   * 返回的 PreparedOAuthFlow 应存在 flow store 中，
   * 并把 authUrl、state、flowId 返回给客户端。
   */
  async prepareOAuth(
    source: LoadedSource,
    options: { callbackPort?: number; callbackUrl?: string },
  ): Promise<PreparedOAuthFlow> {
    const { callbackPort } = options;
    const relayReturnTo = options.callbackUrl;
    // 当提供 callbackUrl（WebUI）时，让 provider 看到的 redirect_uri 固定，
    // 这样 Google 等只需注册一个回调地址。
    // relay 会从外层 state 里解出真实的服务器回调目标。
    const providerCallbackUrl = relayReturnTo
      ? OAUTH_RELAY_CALLBACK_URL
      : undefined;
    const provider = this.detectProvider(source);

    let prepared: PreparedOAuthFlow;

    switch (provider) {
      case 'google': {
        const api = source.config.api;
        let service: GoogleService | undefined;
        let scopes: string[] | undefined;

        if (api?.googleScopes && api.googleScopes.length > 0) {
          scopes = api.googleScopes;
        } else if (api?.googleService) {
          service = api.googleService;
        } else {
          service = inferGoogleServiceFromUrl(api?.baseUrl);
          if (!service) {
            throw new Error(
              `Cannot determine Google service for source '${source.config.slug}'. ` +
              `Set googleService in api config.`
            );
          }
        }

        prepared = prepareGoogleOAuth({
          service,
          scopes,
          callbackPort,
          callbackUrl: providerCallbackUrl,
          clientId: api?.googleOAuthClientId,
          clientSecret: api?.googleOAuthClientSecret,
        });
        break;
      }

      case 'slack': {
        const api = source.config.api;
        let service: import('./types.ts').SlackService | undefined;
        let userScopes: string[] | undefined;

        if (api?.slackUserScopes && api.slackUserScopes.length > 0) {
          userScopes = api.slackUserScopes;
        } else if (api?.slackService) {
          service = api.slackService;
        } else {
          service = inferSlackServiceFromUrl(api?.baseUrl) || 'full';
        }

        prepared = prepareSlackOAuth({ service, userScopes, callbackPort, callbackUrl: providerCallbackUrl });
        break;
      }

      case 'microsoft': {
        const api = source.config.api;
        let service: MicrosoftService | undefined;
        let scopes: string[] | undefined;

        if (api?.microsoftScopes && api.microsoftScopes.length > 0) {
          scopes = api.microsoftScopes;
        } else if (api?.microsoftService) {
          service = api.microsoftService;
        } else {
          service = inferMicrosoftServiceFromUrl(api?.baseUrl);
          if (!service) {
            throw new Error(
              `Cannot determine Microsoft service for source '${source.config.slug}'. ` +
              `Set microsoftService in api config.`
            );
          }
        }

        prepared = prepareMicrosoftOAuth({ service, scopes, callbackPort, callbackUrl: providerCallbackUrl });
        break;
      }

      case 'generic': {
        const oauthConfig = source.config.api?.oauth;
        if (oauthConfig) {
          // 静态配置：端点在 config.json 里直接给出
          prepared = prepareGenericOAuth({ oauthConfig, callbackPort, callbackUrl: providerCallbackUrl });
        } else {
          // 自动发现：访问 baseUrl，通过 RFC 9728/8414 发现 OAuth 元数据，
          // 并动态注册客户端 —— 内部复用 MCP OAuth 逻辑。
          const baseUrl = source.config.api?.baseUrl;
          if (!baseUrl) {
            throw new Error(`Source '${source.config.slug}' missing api.baseUrl for OAuth discovery`);
          }
          prepared = await prepareMcpOAuth(baseUrl, { callbackPort, callbackUrl: providerCallbackUrl });
          // 重新标记为 generic（虽然内部用了 MCP 自动发现，但本质是 API source）
          prepared = { ...prepared, provider: 'generic' };
        }
        break;
      }

      case 'mcp': {
        if (!source.config.mcp?.url) {
          throw new Error('MCP URL not configured');
        }
        prepared = await prepareMcpOAuth(source.config.mcp.url, { callbackPort, callbackUrl: providerCallbackUrl });
        break;
      }
    }

    return relayReturnTo
      ? wrapPreparedOAuthFlowForRelay(prepared, relayReturnTo)
      : prepared;
  }

  /**
   * 用授权码换取 token 并保存（服务端）。
   *
   * 客户端把 OAuth 回调拿到的 code 转发过来后调用本函数。
   * 它会路由到对应 provider 的 exchange，保存凭证，并标记 source 已认证。
   */
  async exchangeAndStore(
    source: LoadedSource,
    provider: OAuthProvider,
    params: OAuthExchangeParams
  ): Promise<AuthResult> {
    let result: OAuthExchangeResult;

    switch (provider) {
      case 'google':
        result = await exchangeGoogleOAuth(params);
        break;
      case 'slack':
        result = await exchangeSlackOAuth(params);
        break;
      case 'microsoft':
        result = await exchangeMicrosoftOAuth(params);
        break;
      case 'generic':
        result = await exchangeGenericOAuth(params);
        break;
      case 'mcp':
        result = await exchangeMcpOAuth(params);
        break;
    }

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // 保存凭证
    await this.save(source, {
      value: result.accessToken!,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      clientId: result.oauthClientId,
      clientSecret: result.oauthClientSecret,
    });

    // 在 config.json 里标记 source 已认证
    markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

    debug(`[SourceCredentialManager] OAuth exchange+store complete for ${source.config.slug}`);
    return { success: true, email: result.email };
  }

  // ============================================================
  // OAuth 认证（一站式便捷包装，主要用于 CLI/测试）
  // ============================================================

  /**
   * 通过 OAuth 认证 source
   *
   * 处理 MCP OAuth 和 Gmail OAuth 等流程。
   * 成功后会自动保存凭证。
   */
  async authenticate(
    source: LoadedSource,
    callbacks?: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    const defaultCallbacks: OAuthCallbacks = {
      onStatus: (msg) => debug(`[SourceCredentialManager] ${msg}`),
      onError: (err) => debug(`[SourceCredentialManager] Error: ${err}`),
    };
    const cb = callbacks || defaultCallbacks;

    // Google API 用 Google OAuth
    if (source.config.provider === 'google') {
      return this.authenticateGoogle(source, cb, sessionContext);
    }

    // Slack API 用 Slack OAuth
    if (source.config.provider === 'slack') {
      return this.authenticateSlack(source, cb, sessionContext);
    }

    // Microsoft API 用 Microsoft OAuth
    if (source.config.provider === 'microsoft') {
      return this.authenticateMicrosoft(source, cb, sessionContext);
    }

    // 通用 OAuth（显式配置或从 baseUrl 自动发现）
    if (source.config.api?.authType === 'oauth') {
      return this.authenticateGeneric(source, cb, sessionContext);
    }

    // MCP OAuth 流程
    if (source.config.type === 'mcp' && source.config.mcp?.authType === 'oauth') {
      return this.authenticateMcp(source, cb, sessionContext);
    }

    return {
      success: false,
      error: `Source ${source.config.slug} does not use OAuth authentication`,
    };
  }

  /**
   * 通过 OAuth 认证 MCP source
   */
  private async authenticateMcp(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    if (!source.config.mcp?.url) {
      return { success: false, error: 'MCP URL not configured' };
    }

    try {
      const oauth = new CraftOAuth(
        { mcpUrl: source.config.mcp.url },
        callbacks,
        sessionContext
      );

      const { tokens, clientId } = await oauth.authenticate();

      // 保存凭证
      await this.save(source, {
        value: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId,
        tokenType: tokens.tokenType,
      });

      // 在 config.json 里标记 source 已认证
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * 通过 Google OAuth 认证 Google API source
   *
   * 支持多种 Google 服务（Gmail、Calendar、Drive 等）：
   * - provider: "google" 并设置 googleService
   * - provider: "google" 并设置自定义 googleScopes
   * - 从 baseUrl 推断（例如 gmail.googleapis.com → gmail）
   */
  private async authenticateGoogle(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    try {
      // 从配置中确定 service/scopes
      const api = source.config.api;
      let service: GoogleService | undefined;
      let scopes: string[] | undefined;

      if (api?.googleScopes && api.googleScopes.length > 0) {
        // 自定义 scope 优先级最高
        scopes = api.googleScopes;
      } else if (api?.googleService) {
        // 使用预定义服务的 scope
        service = api.googleService;
      } else {
        // 从 baseUrl 推断
        service = inferGoogleServiceFromUrl(api?.baseUrl);
        if (!service) {
          return {
            success: false,
            error: `Cannot determine Google service for source '${source.config.slug}'. Set googleService ('gmail', 'calendar', 'drive', 'docs', 'sheets', 'youtube', or 'searchconsole') in api config.`,
          };
        }
      }

      const serviceName = service || 'Google API';
      callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);

      const options: GoogleOAuthOptions = {
        service,
        scopes,
        appType: 'electron',
        // 如果 source 配置里提供了用户自己的 OAuth 凭据，则传进去
        clientId: api?.googleOAuthClientId,
        clientSecret: api?.googleOAuthClientSecret,
        sessionContext,
      };

      const result: GoogleOAuthResult = await startGoogleOAuth(options);

      if (!result.success) {
        return { success: false, error: result.error || 'Google OAuth failed' };
      }

      // 保存凭证（包含 clientId/clientSecret，用于后续 token 刷新）
      await this.save(source, {
        value: result.accessToken!,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        clientId: result.clientId,
        clientSecret: result.clientSecret,
      });

      // 在 config.json 里标记 source 已认证
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      callbacks.onStatus(`${serviceName} authentication successful`);
      return { success: true, email: result.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * 通过 Slack OAuth 认证 Slack API source
   *
   * 支持多种 Slack 服务：
   * - provider: "slack" 并设置 slackService
   * - provider: "slack" 并设置自定义 slackBotScopes/slackUserScopes
   * - 从 baseUrl 推断（slack.com → full）
   */
  private async authenticateSlack(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    try {
      // 从配置中确定 service/scopes
      const api = source.config.api;
      let service: SlackService | undefined;
      let userScopes: string[] | undefined;

      if (api?.slackUserScopes && api.slackUserScopes.length > 0) {
        // 自定义 scope 优先级最高
        userScopes = api.slackUserScopes;
      } else if (api?.slackService) {
        // 使用预定义服务的 scope
        service = api.slackService;
      } else {
        // 从 baseUrl 推断（默认 full）
        service = inferSlackServiceFromUrl(api?.baseUrl) || 'full';
      }

      const serviceName = service ? `Slack ${service}` : 'Slack';
      callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);

      const options: SlackOAuthOptions = {
        service,
        userScopes,
        appType: 'electron',
        sessionContext,
      };

      const result: SlackOAuthResult = await startSlackOAuth(options);

      if (!result.success) {
        return { success: false, error: result.error || 'Slack OAuth failed' };
      }

      // 保存凭证
      await this.save(source, {
        value: result.accessToken!,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      });

      // 在 config.json 里标记 source 已认证
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      callbacks.onStatus(`${serviceName} authentication successful`);
      // 用 teamName 作为标识（类似 Google 的 email）
      return { success: true, email: result.teamName };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * 通过 Microsoft OAuth 认证 Microsoft API source
   *
   * 支持多种 Microsoft 服务（Outlook、OneDrive、Calendar、Teams 等）：
   * - provider: "microsoft" 并设置 microsoftService
   * - provider: "microsoft" 并设置自定义 microsoftScopes
   * - 从 baseUrl 推断（例如 graph.microsoft.com → outlook）
   */
  private async authenticateMicrosoft(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    try {
      // 从配置中确定 service/scopes
      const api = source.config.api;
      let service: MicrosoftService | undefined;
      let scopes: string[] | undefined;

      if (api?.microsoftScopes && api.microsoftScopes.length > 0) {
        // 自定义 scope 优先级最高
        scopes = api.microsoftScopes;
      } else if (api?.microsoftService) {
        // 使用预定义服务的 scope
        service = api.microsoftService;
      } else {
        // 从 baseUrl 推断
        service = inferMicrosoftServiceFromUrl(api?.baseUrl);
        if (!service) {
          return {
            success: false,
            error: `Cannot determine Microsoft service for source '${source.config.slug}'. Set microsoftService ('outlook', 'calendar', 'onedrive', 'teams', or 'sharepoint') in api config.`,
          };
        }
      }

      const serviceName = service || 'Microsoft API';
      callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);

      const options: MicrosoftOAuthOptions = {
        service,
        scopes,
        appType: 'electron',
        sessionContext,
      };

      const result: MicrosoftOAuthResult = await startMicrosoftOAuth(options);

      if (!result.success) {
        return { success: false, error: result.error || 'Microsoft OAuth failed' };
      }

      // 保存凭证
      await this.save(source, {
        value: result.accessToken!,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      });

      // 在 config.json 里标记 source 已认证
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      callbacks.onStatus(`${serviceName} authentication successful`);
      return { success: true, email: result.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * 刷新 source 的 token
   *
   * 返回新的 access token；刷新失败返回 null。
   * 成功后会自动更新已存凭证。
   *
   * 使用 Promise 去重，防止同一个 source 并发刷新。
   * 这很重要，因为：
   * - token 快过期时多个 API 调用可能同时触发刷新
   * - Microsoft 会轮换 refresh token，并发刷新可能导致 token 失效
   */
  async refresh(source: LoadedSource): Promise<string | null> {
    const key = source.config.slug;

    // 如果已有正在刷新的 Promise，直接复用
    const pending = this.pendingRefreshes.get(key);
    if (pending) {
      debug(`[SourceCredentialManager] Reusing pending refresh for ${key}`);
      return pending;
    }

    // 创建并跟踪新的刷新 Promise
    const refreshPromise = this.doRefresh(source).finally(() => {
      this.pendingRefreshes.delete(key);
    });

    this.pendingRefreshes.set(key, refreshPromise);
    return refreshPromise;
  }

  /**
   * 内部刷新实现
   */
  private async doRefresh(source: LoadedSource): Promise<string | null> {
    const cred = await this.load(source);
    if (!cred) {
      debug(`[SourceCredentialManager] No credential for ${source.config.slug}`);
      return null;
    }

    // API 续期端点（非 OAuth token 刷新）—— 在按 provider 路由前先检查。
    // 这类 source 可能没有单独 refreshToken，而是用当前 access token 续期。
    if (hasRenewEndpoint(source)) {
      return this.refreshApiRenew(source, cred);
    }

    // 其他刷新策略都需要 refreshToken
    if (!cred.refreshToken) {
      debug(`[SourceCredentialManager] No refresh token for ${source.config.slug}`);
      return null;
    }

    // Google API 刷新
    if (source.config.provider === 'google') {
      return this.refreshGoogle(source, cred);
    }

    // Slack API 刷新
    if (source.config.provider === 'slack') {
      return this.refreshSlack(source, cred);
    }

    // Microsoft API 刷新
    if (source.config.provider === 'microsoft') {
      return this.refreshMicrosoft(source, cred);
    }

    // 通用 OAuth 刷新
    if (source.config.api?.authType === 'oauth') {
      if (source.config.api?.oauth?.tokenUrl) {
        // 静态配置：tokenUrl 来自 config.json
        return this.refreshGeneric(source, cred);
      }
      // 自动发现：从 baseUrl 重新发现 token 端点，走 MCP OAuth 刷新
      if (source.config.api?.baseUrl && cred.clientId) {
        return this.refreshMcp(
          { ...source, config: { ...source.config, type: 'mcp', mcp: { url: source.config.api.baseUrl, authType: 'oauth' } } },
          cred,
        );
      }
      return null;
    }

    // MCP 刷新
    if (source.config.type === 'mcp' && source.config.mcp?.url) {
      return this.refreshMcp(source, cred);
    }

    return null;
  }

  /**
   * 通过自定义 API 续期端点刷新 token（非 OAuth）。
   * 用当前 access token 续期，不需要单独 refresh token。
   */
  private async refreshApiRenew(
    source: LoadedSource,
    cred: StoredCredential,
  ): Promise<string | null> {
    const renewConfig = source.config.api?.renewEndpoint;
    if (!renewConfig?.path) return null;

    const baseUrl = source.config.api!.baseUrl;
    const authScheme = source.config.api!.authScheme;
    const currentToken = cred.value;

    try {
      // 1. 解析 URL
      const url = renewConfig.path.startsWith('http')
        ? renewConfig.path
        : new URL(renewConfig.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();

      // 2. 构造请求头：defaultHeaders < renewEndpoint.headers < Authorization
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...source.config.api!.defaultHeaders,
        ...substituteTokenInHeaders(renewConfig.headers, currentToken),
      };
      // 除非 renewEndpoint.headers 里显式覆盖了 Authorization，否则加上默认 Authorization
      if (!renewConfig.headers?.['Authorization'] && !renewConfig.headers?.['authorization']) {
        headers['Authorization'] = buildAuthorizationHeader(authScheme, currentToken);
      }

      // 3. 构造 body，替换 {{token}} 占位符
      const method = renewConfig.method ?? 'POST';
      const fetchOptions: RequestInit = { method, headers };
      if (renewConfig.body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(substituteTokenInBody(renewConfig.body, currentToken));
      }

      // 4. 发送请求
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Renew endpoint returned ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const json = await response.json() as Record<string, unknown>;

      // 5. 提取新 token
      const tokenField = renewConfig.tokenField ?? 'access_token';
      const newToken = json[tokenField];
      if (typeof newToken !== 'string' || !newToken) {
        throw new Error(`Renew response missing "${tokenField}" field`);
      }

      // 6. 提取过期时间
      const expiresInField = renewConfig.expiresInField ?? 'expires_in';
      const expiresInRaw = json[expiresInField];
      let expiresAt: number | undefined;
      if (typeof expiresInRaw === 'number' && expiresInRaw > 0) {
        expiresAt = Date.now() + expiresInRaw * 1000;
      } else if (renewConfig.fallbackTtlSecs) {
        expiresAt = Date.now() + renewConfig.fallbackTtlSecs * 1000;
      }
      // 如果都没有，expiresAt 保持 undefined —— needsRefresh() 会在下次会话启动时触发刷新（安全但吵闹）

      // 7. 保存更新后的凭证
      await this.save(source, {
        ...cred,
        value: newToken,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });

      debug(`[SourceCredentialManager] Refreshed token via renew endpoint for ${source.config.slug}`);
      return newToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Renew endpoint refresh failed for ${source.config.slug}:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * 刷新 Google OAuth token
   */
  private async refreshGoogle(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    try {
      // 传入已保存的凭据（未填则回退到环境变量）
      const result = await refreshGoogleToken(
        cred.refreshToken!,
        cred.clientId,
        cred.clientSecret
      );

      // 更新存储的凭证
      await this.save(source, {
        ...cred,
        value: result.accessToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed Google token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Google token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * 刷新 Slack OAuth token
   */
  private async refreshSlack(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    try {
      const result = await refreshSlackToken(cred.refreshToken!, cred.clientId);

      // 更新存储的凭证
      await this.save(source, {
        ...cred,
        value: result.accessToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed Slack token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Slack token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * 刷新 Microsoft OAuth token
   */
  private async refreshMicrosoft(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    try {
      const result = await refreshMicrosoftToken(cred.refreshToken!);

      // 更新存储的凭证（Microsoft 可能会轮换 refresh token）
      await this.save(source, {
        ...cred,
        value: result.accessToken,
        refreshToken: result.refreshToken || cred.refreshToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed Microsoft token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Microsoft token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * 通过通用 OAuth 流程认证 source（CLI/测试用的便捷包装）。
   * 注意：桌面端的会话级 UI 流程走 prepareOAuth() + exchangeAndStore()。
   */
  private async authenticateGeneric(
    source: LoadedSource,
    _cb: OAuthCallbacks,
    _sessionContext?: OAuthSessionContext,
  ): Promise<AuthResult> {
    const oauthConfig = source.config.api?.oauth;
    if (!oauthConfig) {
      return { success: false, error: 'Source missing api.oauth config block' };
    }

    // CLI 通用 OAuth 还没实现 —— 桌面端通过 source_oauth_trigger → prepareOAuth → exchangeAndStore 流程处理
    return { success: false, error: 'Generic OAuth CLI flow not supported — use the desktop app or source_oauth_trigger tool' };
  }

  /**
   * 刷新通用 OAuth token。
   * tokenUrl 来自 source 配置，clientId/clientSecret 优先用已存凭证，回退到配置。
   */
  private async refreshGeneric(
    source: LoadedSource,
    cred: StoredCredential,
  ): Promise<string | null> {
    const oauthConfig = source.config.api?.oauth;
    if (!oauthConfig?.tokenUrl) {
      debug(`[SourceCredentialManager] No tokenUrl in config for generic OAuth refresh`);
      this.markSourceNeedsReauth(source, 'Missing tokenUrl in api.oauth config');
      return null;
    }

    try {
      const result = await refreshGenericOAuthToken(
        cred.refreshToken!,
        oauthConfig.tokenUrl,
        cred.clientId || oauthConfig.clientId,
        cred.clientSecret || oauthConfig.clientSecret,
      );

      await this.save(source, {
        ...cred,
        value: result.accessToken,
        refreshToken: result.refreshToken || cred.refreshToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed generic OAuth token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Generic OAuth token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * 刷新 MCP OAuth token
   */
  private async refreshMcp(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    if (!cred.clientId) {
      debug(`[SourceCredentialManager] No clientId for MCP token refresh`);
      this.markSourceNeedsReauth(source, 'Missing clientId for token refresh');
      return null;
    }

    try {
      // 只有 HTTP/SSE 传输能刷新 token —— stdio 不走 OAuth
      if (!source.config.mcp?.url) {
        // stdio 传输没有 URL，这是预期行为，不算错误
        debug(`[SourceCredentialManager] No URL for MCP token refresh (stdio transport)`);
        return null;
      }

      const oauth = new CraftOAuth(
        { mcpUrl: source.config.mcp.url },
        {
          onStatus: () => {},
          onError: () => {},
        }
      );

      const tokens = await oauth.refreshAccessToken(cred.refreshToken!, cred.clientId);

      // 更新存储的凭证
      await this.save(source, {
        ...cred,
        value: tokens.accessToken,
        refreshToken: tokens.refreshToken || cred.refreshToken,
        expiresAt: tokens.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed MCP token for ${source.config.slug}`);
      return tokens.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] MCP token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }
}

// ============================================================
// renew endpoint 的 {{token}} 替换辅助函数
// ============================================================

/**
 * 递归替换对象字符串叶子节点里的 {{token}}。
 * 支持嵌套对象和数组。
 */
function substituteTokenInBody(obj: Record<string, unknown>, token: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\{\{token\}\}/g, token);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string' ? item.replace(/\{\{token\}\}/g, token) :
          (item && typeof item === 'object' ? substituteTokenInBody(item as Record<string, unknown>, token) : item)
      );
    } else if (value && typeof value === 'object') {
      result[key] = substituteTokenInBody(value as Record<string, unknown>, token);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 替换 header 值里的 {{token}} 占位符。
 */
function substituteTokenInHeaders(
  headers: Record<string, string> | undefined,
  token: string,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = value.replace(/\{\{token\}\}/g, token);
  }
  return result;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 判断单个 source 是否需要认证。
 * 返回 true 当 source 需要认证但还没认证。
 *
 * 这是 isSourceUsable() 认证部分的**反逻辑**：
 * - isSourceUsable() → source 是否可用？（已启用 AND 认证 OK）
 * - sourceNeedsAuthentication() → source 是否需要认证才能变得可用？
 *
 * 用这个函数来提示用户认证，而不是用来过滤 source。
 * 过滤 source 请用 storage.ts 的 isSourceUsable()。
 *
 * 正确处理以下情况：
 * - MCP authType: "none" → 永远不需要认证
 * - MCP stdio 传输 → 永远不需要认证（本地运行）
 * - MCP oauth/bearer → 未认证时需要认证
 * - API authType: "none" → 永远不需要认证
 * - API bearer/basic/header/query → 未认证时需要认证
 */
export function sourceNeedsAuthentication(source: LoadedSource): boolean {
  const mcp = source.config.mcp;
  const api = source.config.api;

  // MCP source：oauth/bearer 需要认证（stdio 本地运行不需要）
  if (source.config.type === 'mcp' && mcp) {
    if (mcp.transport === 'stdio') {
      // stdio source 本地运行，不需要认证
      return false;
    }
    // 只有 authType 显式为 'oauth' 或 'bearer' 时才需要认证
    // 未定义或 'none' 表示不需要认证
    if (mcp.authType && mcp.authType !== 'none' && !source.config.isAuthenticated) {
      return true;
    }
  }

  // API source：有认证要求时需要认证
  if (source.config.type === 'api' && api) {
    if (api.authType !== 'none' && api.authType !== undefined && !source.config.isAuthenticated) {
      return true;
    }
  }

  return false;
}

/**
 * 获取所有需要认证的 source。
 * 返回已启用、需要认证但尚未认证的 source。
 */
export function getSourcesNeedingAuth(sources: LoadedSource[]): LoadedSource[] {
  return sources.filter((source) => {
    if (!source.config.enabled) return false;
    return sourceNeedsAuthentication(source);
  });
}

// 单例
let instance: SourceCredentialManager | null = null;

/**
 * 获取共享的 SourceCredentialManager 实例
 */
export function getSourceCredentialManager(): SourceCredentialManager {
  if (!instance) {
    instance = new SourceCredentialManager();
  }
  return instance;
}
