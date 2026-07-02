/**
 * MCP 服务器的 OAuth 客户端实现
 *
 * 本模块负责与需要 OAuth 授权的 MCP（Model Context Protocol）服务器对接：
 * 1. 发现 OAuth 授权服务器元数据（metadata discovery）
 * 2. 动态注册 OAuth 客户端
 * 3. 生成 PKCE、启动本地回调服务器
 * 4. 打开浏览器完成授权
 * 5. 用授权码换 token
 * 6. 刷新 access token
 *
 * 对 Agent 初学者来说：MCP 是 Agent 和外部工具/数据源通信的协议；
 * 这里的 OAuth 就是 Agent 连接某个 MCP 服务器前的“登录”步骤。
 */

import { createServer, type Server } from 'http';
import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { generateCallbackPage } from './callback-page.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';

/**
 * CraftOAuth 类构造时需要的配置。
 */
export interface OAuthConfig {
  /** 完整 MCP URL，包含路径，例如 https://mcp.craft.do/my/mcp */
  mcpUrl: string;
}

/**
 * OAuth token 结果。
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}

/**
 * 回调函数：用于向调用方报告状态和错误。
 * 类似 Go 里的回调接口或 channel。
 */
export interface OAuthCallbacks {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
}

// 本地 OAuth 回调服务器端口范围：顺序尝试直到有可用端口
const CALLBACK_PORT_START = 8914;
const CALLBACK_PORT_END = 8924;
const CALLBACK_PATH = '/oauth/callback';
const CLIENT_NAME = 'Claude Code (Craft Agent)';

/**
 * 生成 PKCE verifier 和 challenge。
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * 生成随机 state，防止 CSRF。
 */
function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * CraftOAuth 主类。
 *
 * 封装了 MCP 服务器的完整 OAuth 登录流程。
 * 对 Go 同学来说，可以把它理解成一个带状态的工作流对象，
 * 类似一个 http.Client 加上一组专属的登录方法。
 */
export class CraftOAuth {
  private config: OAuthConfig;
  private server: Server | null = null;
  private callbacks: OAuthCallbacks;
  private sessionContext?: OAuthSessionContext;

  constructor(config: OAuthConfig, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext) {
    this.config = config;
    this.callbacks = callbacks;
    this.sessionContext = sessionContext;
  }

  /**
   * 渐进式发现 OAuth 授权服务器元数据。
   * 如果找不到会抛出错误。
   */
  private async getServerMetadata(): Promise<OAuthMetadata> {
    const metadata = await discoverOAuthMetadata(
      this.config.mcpUrl,
      (msg) => this.callbacks.onStatus(msg)
    );

    if (!metadata) {
      throw new Error(`No OAuth metadata found for ${this.config.mcpUrl}`);
    }

    return metadata;
  }

  /**
   * 动态注册 OAuth 客户端。
   * 部分 MCP 服务器支持动态客户端注册（RFC 7591）。
   *
   * @param registrationEndpoint - 注册端点
   * @param port - 本地回调服务器端口，用于构造 redirect_uri
   * @returns 注册得到的 client_id 和可选的 client_secret
   */
  private async registerClient(registrationEndpoint: string, port: number): Promise<{
    client_id: string;
    client_secret?: string;
  }> {
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    const response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // 公共客户端，不需要 client_secret
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register OAuth client: ${error}`);
    }

    return response.json() as Promise<{
      client_id: string;
      client_secret?: string;
    }>;
  }

  /**
   * 用授权码换 token。
   *
   * @param tokenEndpoint - token 端点
   * @param code - 授权码
   * @param codeVerifier - PKCE verifier
   * @param clientId - 客户端 ID
   * @param port - 本地回调端口
   */
  private async exchangeCodeForTokens(
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
    clientId: string,
    port: number
  ): Promise<OAuthTokens> {
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for tokens: ${error}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    // 如果服务端没返回 expires_in，默认按 3600 秒（1 小时）处理。
    // 大多数 OAuth access token 按 RFC 6749 都是 1 小时有效期；
    // 没有这个默认值，那些不返回 expires_in 的 token 就永远不会被检测到需要刷新。
    const expiresIn = data.expires_in ?? 3600;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: data.token_type || 'Bearer',
    };
  }

  /**
   * 用 refresh token 刷新 access token。
   */
  async refreshAccessToken(
    refreshToken: string,
    clientId: string
  ): Promise<OAuthTokens> {
    const metadata = await this.getServerMetadata();

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });

    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const expiresIn = data.expires_in ?? 3600;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: data.token_type || 'Bearer',
    };
  }

  /**
   * 检查 MCP 服务器是否需要 OAuth 认证。
   * 通过尝试发现 OAuth 元数据来判断。
   */
  async checkAuthRequired(): Promise<boolean> {
    this.callbacks.onStatus('Checking if authentication is required...');

    try {
      const metadata = await discoverOAuthMetadata(
        this.config.mcpUrl,
        (msg) => this.callbacks.onStatus(msg)
      );

      if (metadata) {
        this.callbacks.onStatus('OAuth required - server has OAuth metadata');
        return true;
      }

      // 任何候选 URL 都没找到元数据
      this.callbacks.onStatus('No OAuth metadata found - server may be public');
      return false;
    } catch (error) {
      this.callbacks.onStatus('Could not reach OAuth metadata - assuming public');
      return false;
    }
  }

  /**
   * 启动完整 OAuth 登录流程。
   *
   * 步骤：
   * 1. 发现 OAuth 服务器元数据
   * 2. 生成 PKCE 和 state
   * 3. 启动本地回调服务器
   * 4. 动态注册客户端（如果服务器支持）
   * 5. 构造授权 URL
   * 6. 打开浏览器
   * 7. 等待授权码回调
   * 8. 用授权码换 token
   *
   * @returns tokens 和 clientId
   */
  async authenticate(): Promise<{ tokens: OAuthTokens; clientId: string }> {
    this.callbacks.onStatus('Fetching OAuth server configuration...');

    // 1. 获取服务器元数据（不依赖端口）
    let metadata;
    try {
      metadata = await this.getServerMetadata();
      this.callbacks.onStatus(`Found OAuth endpoints at ${this.config.mcpUrl}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onStatus(`Failed to get OAuth metadata: ${msg}`);
      throw error;
    }

    // 2. 生成 PKCE 和 state（无依赖）
    const pkce = generatePKCE();
    const state = generateState();
    this.callbacks.onStatus('Generated PKCE challenge and state');

    // 3. 启动本地回调服务器：直接尝试绑定，返回实际绑定的端口。
    //    这必须在客户端注册之前完成，因为 redirect_uri 包含端口，
    //    我们需要的是“实际绑定”的端口，而不是“先检查再释放”的端口，以避免 TOCTOU 竞态。
    this.callbacks.onStatus('Starting callback server...');
    let port: number;
    let codePromise: Promise<string>;
    try {
      const server = await this.startCallbackServer(state);
      port = server.port;
      codePromise = server.codePromise;
      this.callbacks.onStatus(`Callback server listening on port ${port}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onStatus(`Failed to start callback server: ${msg}`);
      throw error;
    }

    // 4. 如果支持动态注册，现在注册客户端（已拿到绑定端口）
    let clientId: string;
    if (metadata.registration_endpoint) {
      this.callbacks.onStatus(`Registering client at ${metadata.registration_endpoint}...`);
      try {
        const client = await this.registerClient(metadata.registration_endpoint, port);
        clientId = client.client_id;
        this.callbacks.onStatus(`Registered as client: ${clientId}`);
      } catch (error) {
        // 注册失败时关闭回调服务器
        this.stopServer();
        const msg = error instanceof Error ? error.message : 'Unknown error';
        this.callbacks.onStatus(`Client registration failed: ${msg}`);
        throw error;
      }
    } else {
      // 没有注册端点时，使用默认公共客户端 ID
      clientId = 'craft-agent';
      this.callbacks.onStatus(`Using default client ID: ${clientId}`);
    }

    // 5. 构造授权 URL
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // 6. 打开浏览器授权
    this.callbacks.onStatus('Opening browser for authorization...');
    await openUrl(authUrl.toString());

    // 7. 等待授权码回调
    this.callbacks.onStatus('Waiting for you to authorize in browser...');
    const authCode = await codePromise;
    this.callbacks.onStatus('Authorization code received!');

    // 8. 用授权码换 token
    this.callbacks.onStatus('Exchanging authorization code for tokens...');
    const tokens = await this.exchangeCodeForTokens(
      metadata.token_endpoint,
      authCode,
      pkce.verifier,
      clientId,
      port
    );
    this.callbacks.onStatus('Tokens received successfully!');

    return { tokens, clientId };
  }

  /**
   * 启动 OAuth 回调服务器。
   *
   * 在 CALLBACK_PORT_START .. CALLBACK_PORT_END 范围内直接尝试绑定真实服务器。
   * 消除 TOCTOU 竞态：返回的端口就是服务器实际监听的端口，
   * 不存在“检查完再绑定”的时间窗口。遇到 EADDRINUSE 就关闭候选服务器试下一个。
   *
   * 服务器绑定成功后立即返回，codePromise 会在 OAuth 回调送达授权码后 resolve。
   */
  private async startCallbackServer(
    expectedState: string
  ): Promise<{ port: number; codePromise: Promise<string> }> {
    // 构造一个 deferred Promise，由请求处理器来 resolve/reject
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    // 5 分钟超时：如果一直没收到回调就拒绝并关闭服务器
    const timeout = setTimeout(() => {
      this.stopServer();
      rejectCode(new Error('OAuth timeout - no callback received'));
    }, 300000);

    // 逐个端口尝试绑定
    for (let port = CALLBACK_PORT_START; port <= CALLBACK_PORT_END; port++) {
      const candidate = createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname === CALLBACK_PATH) {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: error,
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error(`OAuth error: ${error}`));
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Security Error',
              isSuccess: false,
              errorDetail: 'State mismatch - possible CSRF attack.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('OAuth state mismatch'));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: 'No authorization code received.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('No authorization code'));
            return;
          }

          // 成功：返回成功页面，并 resolve code
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(generateCallbackPage({
            title: 'Authorization Successful',
            isSuccess: true,
            deeplinkUrl: buildOAuthDeeplinkUrl(this.sessionContext),
          }));

          clearTimeout(timeout);
          this.stopServer();
          resolveCode(code);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('error', reject);
          candidate.listen(port, 'localhost', () => {
            candidate.removeListener('error', reject);
            resolve();
          });
        });

        // 绑定成功：保留这个服务器
        this.server = candidate;
        this.server.on('error', (err) => {
          clearTimeout(timeout);
          rejectCode(new Error(`Callback server error: ${err.message}`));
        });
        return { port, codePromise };
      } catch (err: unknown) {
        // 端口被占用：关闭候选服务器并试下一个
        candidate.close();
        const isAddressInUse =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (!isAddressInUse) {
          // 非占用错误：清理并抛出
          clearTimeout(timeout);
          throw err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    // 所有端口都试完了
    clearTimeout(timeout);
    throw new Error(
      `All OAuth callback ports (${CALLBACK_PORT_START}-${CALLBACK_PORT_END}) are in use. Please restart the application.`
    );
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * 取消 OAuth 流程：关闭本地回调服务器。
   */
  cancel(): void {
    this.stopServer();
  }
}

/**
 * MCP OAuth 客户端动态注册错误。
 * 从 CraftOAuth.registerClient 提取出来，供 prepareMcpOAuth 复用。
 */
class McpClientRegistrationError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpClientRegistrationError';
    this.status = status;
  }
}

/**
 * 判断是否回退到默认 MCP 客户端 ID。
 * 当动态注册返回 401/403 时，可能是提供商限制了未审核客户端，此时回退到默认 ID 继续流程。
 */
function shouldFallbackToDefaultMcpClient(error: unknown): boolean {
  return error instanceof McpClientRegistrationError && (error.status === 401 || error.status === 403);
}

/**
 * 向 MCP OAuth 注册端点动态注册客户端。
 *
 * @param registrationEndpoint - 注册端点
 * @param redirectUri - 重定向 URI
 * @returns client_id 和可选 client_secret
 */
async function registerMcpOAuthClient(
  registrationEndpoint: string,
  redirectUri: string
): Promise<{ client_id: string; client_secret?: string }> {
  let response: Response;
  try {
    response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpClientRegistrationError(`Failed to register OAuth client: ${message}`);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new McpClientRegistrationError(`Failed to register OAuth client: ${error}`, response.status);
  }

  return response.json() as Promise<{ client_id: string; client_secret?: string }>;
}

/**
 * 用 MCP 授权码换 token（独立函数，不需要类实例）。
 */
async function exchangeMcpCodeForTokens(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const expiresIn = data.expires_in ?? 3600;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: data.token_type || 'Bearer',
  };
}

/**
 * 准备 MCP OAuth 流程，不启动回调服务器也不打开浏览器。
 *
 * 执行元数据发现、PKCE 生成、可选的客户端注册、授权 URL 构造。
 * 接受 callbackPort（Electron）或 callbackUrl（WebUI）来构造 redirect_uri。
 *
 * @param mcpUrl - MCP 服务器 URL
 * @param options.callbackPort - 本地回调端口
 * @param options.callbackUrl - 完整回调 URL
 */
export async function prepareMcpOAuth(
  mcpUrl: string,
  options: { callbackPort?: number; callbackUrl?: string },
): Promise<PreparedOAuthFlow> {
  const metadata = await discoverOAuthMetadata(mcpUrl);
  if (!metadata) {
    throw new Error(`No OAuth metadata found for ${mcpUrl}`);
  }

  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}${CALLBACK_PATH}`;

  let clientId: string;
  let clientSecret: string | undefined;
  if (metadata.registration_endpoint) {
    try {
      const client = await registerMcpOAuthClient(metadata.registration_endpoint, redirectUri);
      clientId = client.client_id;
      clientSecret = client.client_secret;
    } catch (error) {
      if (!shouldFallbackToDefaultMcpClient(error)) {
        throw error;
      }

      // 动态客户端注册可能被提供商故意限制（例如未审核客户端返回 403）。
      // 这种情况下回退到默认客户端 ID，继续完成流程。
      clientId = 'craft-agent';
    }
  } else {
    clientId = 'craft-agent';
  }

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    clientSecret,
    redirectUri,
    provider: 'mcp',
  };
}

/**
 * 在服务端用 MCP 授权码换 token。
 */
export async function exchangeMcpOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeMcpCodeForTokens(
      params.tokenEndpoint,
      params.code,
      params.codeVerifier,
      params.clientId,
      params.redirectUri
    );

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      oauthClientId: params.clientId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'MCP OAuth exchange failed',
    };
  }
}

/**
 * 从 MCP URL 中提取 origin（scheme + host + port）。
 * 这是 RFC 8414 规定的 OAuth discovery 基础 URL。
 */
export function getMcpBaseUrl(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    // URL 解析失败时原样返回，让调用方处理
    return mcpUrl;
  }
}

/**
 * OAuth 授权服务器元数据。
 */
export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/**
 * 尝试从指定 URL 获取 OAuth 授权服务器元数据。
 * 成功返回元数据；失败或找不到返回 null。
 */
async function tryFetchAuthServerMetadata(
  url: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.(`  Trying: ${url}`);
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json() as OAuthMetadata;
      if (data.authorization_endpoint && data.token_endpoint) {
        onLog?.(`  ✓ Found OAuth metadata at ${url}`);
        return data;
      }
      onLog?.(`  ✗ Invalid metadata at ${url} (missing required fields)`);
    } else {
      onLog?.(`  ✗ ${response.status} at ${url}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onLog?.(`  ✗ Error fetching ${url}: ${msg}`);
  }
  return null;
}

/**
 * 受保护资源元数据（RFC 9728）。
 */
interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}

/** OAuth discovery 请求默认超时：5 秒 */
const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * 检查 URL 是否可以安全请求（SSRF 防护）。
 * 拒绝私有 IP、localhost、非 HTTPS URL。
 *
 * @returns safe 为 true 表示安全；为 false 时 reason 说明原因
 */
function isUrlSafeToFetch(urlString: string): { safe: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // 必须是 HTTPS（开发环境允许 localhost 用 HTTP）
  if (url.protocol !== 'https:') {
    return { safe: false, reason: 'URL must use HTTPS' };
  }

  // 检查 hostname 是否是私有 IP
  const hostname = url.hostname.toLowerCase();

  // 拦截 localhost 变体
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return { safe: false, reason: 'Localhost not allowed' };
  }

  // 拦截常见私有网段：10.x.x.x、172.16-31.x.x、192.168.x.x、169.254.x.x
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const a = Number(ipMatch[1]);
    const b = Number(ipMatch[2]);
    if (
      a === 0 ||                             // 0.0.0.0/8
      a === 10 ||                           // 10.0.0.0/8
      a === 127 ||                          // 127.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12
      (a === 192 && b === 168) ||           // 192.168.0.0/16
      (a === 169 && b === 254)              // 169.254.0.0/16（链路本地/AWS metadata）
    ) {
      return { safe: false, reason: 'Private IP range not allowed' };
    }
  }

  return { safe: true };
}

/**
 * 类型守卫：判断数据是否符合 ProtectedResourceMetadata 结构。
 *
 * 类型守卫是 TS 特性：函数返回 boolean，但返回 true 时 TS 会把参数收窄成指定类型。
 * 类似 Go 里的 type switch，但由编译器推断。
 */
function isProtectedResourceMetadata(data: unknown): data is ProtectedResourceMetadata {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  // resource 是必填字段
  if (typeof obj.resource !== 'string') return false;

  // authorization_servers 可选，但如果有必须是字符串数组
  if (obj.authorization_servers !== undefined) {
    if (!Array.isArray(obj.authorization_servers)) return false;
    if (!obj.authorization_servers.every(s => typeof s === 'string')) return false;
  }

  return true;
}

/**
 * 带超时的 fetch：用 AbortController 实现。
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DISCOVERY_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 去掉 URL 末尾的斜杠。
 */
function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * 从 WWW-Authenticate 响应头中解析 resource_metadata URL。
 *
 * 示例头：
 * Bearer error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource/path"
 *
 * 支持 RFC 7235 规定的双引号和单引号值。
 */
function parseResourceMetadataFromHeader(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;

  // 查找 resource_metadata="..." 或 resource_metadata='...'
  // 也兼容等号两边有空格的情况
  const match = wwwAuthenticate.match(/resource_metadata\s*=\s*["']([^"']+)["']/);
  return match?.[1] ?? null;
}

/**
 * 获取受保护资源元数据并返回授权服务器 URL。
 *
 * 按 RFC 9728，受保护资源元数据里包含 authorization_servers 数组。
 */
async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  onLog?: (message: string) => void
): Promise<string | null> {
  // SSRF 防护：请求前校验 URL
  const urlCheck = isUrlSafeToFetch(metadataUrl);
  if (!urlCheck.safe) {
    onLog?.(`  ✗ Unsafe URL rejected: ${urlCheck.reason}`);
    return null;
  }

  try {
    onLog?.(`  Fetching protected resource metadata...`);
    const response = await fetchWithTimeout(metadataUrl);
    if (!response.ok) {
      onLog?.(`  ✗ ${response.status} at metadata endpoint`);
      return null;
    }

    const data: unknown = await response.json();

    // 类型守卫校验
    if (!isProtectedResourceMetadata(data)) {
      onLog?.(`  ✗ Invalid protected resource metadata format`);
      return null;
    }

    // 检查 authorization_servers 是否非空
    if (!data.authorization_servers?.length) {
      onLog?.(`  ✗ No authorization_servers in protected resource metadata`);
      return null;
    }

    const authServer = data.authorization_servers[0]!;

    // 授权服务器 URL 也要做 SSRF 校验
    const authServerCheck = isUrlSafeToFetch(authServer);
    if (!authServerCheck.safe) {
      onLog?.(`  ✗ Unsafe authorization server URL rejected: ${authServerCheck.reason}`);
      return null;
    }

    onLog?.(`  ✓ Found authorization server`);
    return authServer;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onLog?.(`  ✗ Request timeout fetching protected resource metadata`);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      onLog?.(`  ✗ Error fetching protected resource metadata: ${msg}`);
    }
    return null;
  }
}

/**
 * 通过 RFC 9728 流程发现 OAuth 元数据：
 * 1. 向 MCP 端点发请求，拿到 401 + WWW-Authenticate 头
 * 2. 从头中解析 resource_metadata URL
 * 3. 获取受保护资源元数据
 * 4. 拿到授权服务器 URL 后再获取其元数据
 */
async function discoverViaProtectedResource(
  mcpUrl: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.(`  Trying RFC 9728 protected resource discovery...`);

    // 向 MCP 端点发请求以触发 401
    // 先尝试 HEAD，不支持再回退 GET，再不支持则 POST（Streamable HTTP MCP 服务器只接受 POST）
    let response: Response;
    try {
      response = await fetchWithTimeout(mcpUrl, { method: 'HEAD' });
      // 有些服务器不支持 HEAD，回退 GET
      if (response.status === 405) {
        onLog?.(`  HEAD not supported, trying GET...`);
        response = await fetchWithTimeout(mcpUrl, { method: 'GET' });
      }
      // Streamable HTTP MCP 服务器只接受 POST。
      // POST 不是安全方法，但这里可以接受：
      // 1. 只在响应为 401 时继续处理，其他状态都忽略
      // 2. 端点是用户配置的、设计上受信任的
      // 3. 请求体 '{}' 对 JSON-RPC 服务器来说是无操作（缺少必填字段）
      if (response.status === 405) {
        onLog?.(`  GET not supported, trying POST...`);
        response = await fetchWithTimeout(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        onLog?.(`  ✗ Request timeout`);
      }
      return null;
    }

    // 期望收到 401 + WWW-Authenticate 头
    if (response.status !== 401) {
      onLog?.(`  ✗ Expected 401, got ${response.status}`);
      return null;
    }

    const wwwAuth = response.headers.get('www-authenticate');
    const resourceMetadataUrl = parseResourceMetadataFromHeader(wwwAuth);

    if (!resourceMetadataUrl) {
      onLog?.(`  ✗ No resource_metadata in WWW-Authenticate header`);
      return null;
    }

    // SSRF 防护：校验 resource_metadata URL
    const urlCheck = isUrlSafeToFetch(resourceMetadataUrl);
    if (!urlCheck.safe) {
      onLog?.(`  ✗ Unsafe resource_metadata URL rejected: ${urlCheck.reason}`);
      return null;
    }

    onLog?.(`  Found resource_metadata hint`);

    // 获取受保护资源元数据，拿到授权服务器
    const authServerUrl = await fetchProtectedResourceMetadata(resourceMetadataUrl, onLog);
    if (!authServerUrl) {
      return null;
    }

    // 获取授权服务器元数据（normalize URL 防止双斜杠）
    const normalizedAuthServer = normalizeUrl(authServerUrl);
    const authServerMetadataUrl = `${normalizedAuthServer}/.well-known/oauth-authorization-server`;
    return await tryFetchAuthServerMetadata(authServerMetadataUrl, onLog);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onLog?.(`  ✗ RFC 9728 discovery failed: ${msg}`);
    return null;
  }
}

/**
 * 渐进式发现 OAuth 元数据（RFC 8414 + RFC 9728）。
 * 返回第一个成功的元数据，全部失败返回 null。
 *
 * 发现顺序：
 * 1. RFC 9728：从 401 响应的 WWW-Authenticate 头解析 resource_metadata
 * 2. Origin 根目录：{origin}/.well-known/oauth-authorization-server
 * 3. Path-scoped：{origin}/.well-known/oauth-authorization-server{pathname}
 */
export async function discoverOAuthMetadata(
  mcpUrl: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    onLog?.(`Invalid MCP URL: ${mcpUrl}`);
    return null;
  }

  onLog?.(`Discovering OAuth metadata for ${mcpUrl}`);

  // 1. 先尝试 RFC 9728 受保护资源发现（适用于 Craft MCP 和其他合规服务器）
  const rfc9728Metadata = await discoverViaProtectedResource(mcpUrl, onLog);
  if (rfc9728Metadata) {
    return rfc9728Metadata;
  }

  // 2. 回退到 RFC 8414 标准发现位置
  const candidates = [
    // Origin 根目录（MCP 服务器最常见）
    `${url.origin}/.well-known/oauth-authorization-server`,
    // Path-scoped（RFC 8414 允许）
    `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
  ];

  for (const candidate of candidates) {
    const metadata = await tryFetchAuthServerMetadata(candidate, onLog);
    if (metadata) {
      return metadata;
    }
  }

  onLog?.(`No OAuth metadata found for ${mcpUrl}`);
  return null;
}
