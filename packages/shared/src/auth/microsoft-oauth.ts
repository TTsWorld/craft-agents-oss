/**
 * Microsoft OAuth 流程
 *
 * 使用 Azure AD OAuth 2.0 with PKCE，处理 Microsoft 365 API 的完整登录流程：
 * 1. 打开浏览器展示 Microsoft 同意页
 * 2. 通过本地回调服务器接收授权码
 * 3. 用授权码换 access/refresh token
 * 4. 返回 token 和用户邮箱/UPN
 *
 * 支持 Outlook、OneDrive、Calendar、Teams 等服务的预定义 scope，也支持自定义 scope。
 *
 * 使用 "common" 租户端点，同时支持个人 Microsoft 账号和 Azure AD 工作/学校账号。
 */

import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { createCallbackServer, type AppType } from './callback-server.ts';
import { type MicrosoftService } from '../sources/types.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';

// 再导出一次 MicrosoftService 类型，方便外部使用
export type { MicrosoftService };

// Microsoft OAuth 配置：通过环境变量注入，编译时固化
// 用于所有 Microsoft 服务（Outlook、OneDrive、Calendar、Teams 等）
// 使用纯 PKCE 流程，公共客户端不需要 client_secret
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_OAUTH_CLIENT_ID || '';

// Microsoft OAuth 端点（"common" 租户支持多租户）
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';

/**
 * 常见 Microsoft 服务的预定义 scope 集合。
 *
 * Microsoft Graph 使用委托权限，格式为 https://graph.microsoft.com/{permission}。
 *
 * 常见权限：
 * - User.Read：登录并读取用户资料
 * - Mail.Read/ReadWrite/Send：邮件访问
 * - Calendars.Read/ReadWrite：日历访问
 * - Files.Read/ReadWrite：OneDrive 访问
 * - Chat.Read/ReadWrite：Teams 聊天访问
 * - offline_access：获取 refresh token 必需
 */
export const MICROSOFT_SERVICE_SCOPES: Record<MicrosoftService, string[]> = {
  outlook: [
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  'microsoft-calendar': [
    'https://graph.microsoft.com/Calendars.ReadWrite',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  onedrive: [
    'https://graph.microsoft.com/Files.ReadWrite',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  teams: [
    'https://graph.microsoft.com/Chat.ReadWrite',
    'https://graph.microsoft.com/ChannelMessage.Send',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  sharepoint: [
    'https://graph.microsoft.com/Sites.ReadWrite.All',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
};

/**
 * 启动 Microsoft OAuth 流程的选项。
 */
export interface MicrosoftOAuthOptions {
  /** 要登录的 Microsoft 服务（使用预定义 scope） */
  service?: MicrosoftService;
  /** 自定义 scope（提供时覆盖 service 的 scope） */
  scopes?: string[];
  /** 回调页面样式 */
  appType?: AppType;
  /** OAuth 完成后跳回聊天 session 的上下文 */
  sessionContext?: OAuthSessionContext;
}

/**
 * Microsoft OAuth 流程结果。
 */
export interface MicrosoftOAuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  error?: string;
}

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
 * 用授权码换 token。
 */
async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * 用 access token 通过 Microsoft Graph 获取用户邮箱/UPN。
 */
async function getUserEmail(accessToken: string): Promise<string> {
  const response = await fetch(MICROSOFT_GRAPH_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info from Microsoft Graph');
  }

  const data = (await response.json()) as {
    mail?: string;
    userPrincipalName?: string;
  };

  // Microsoft Graph 对工作账号返回 mail，个人账号通常用 userPrincipalName 作为兜底
  return data.mail || data.userPrincipalName || 'unknown';
}

/**
 * 用 refresh token 刷新 Microsoft access token。
 */
export async function refreshMicrosoftToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}> {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error('Failed to refresh Microsoft token');
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    // Microsoft 可能会轮换 refresh token
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * 检查 Microsoft OAuth 是否已配置（client ID 已设置）。
 * 注意：公共客户端使用 PKCE，client secret 是可选的。
 */
export function isMicrosoftOAuthConfigured(): boolean {
  return Boolean(MICROSOFT_CLIENT_ID);
}

/**
 * 根据 service 或自定义 scopes 获取最终 scope 列表。
 */
export function getMicrosoftScopes(options: MicrosoftOAuthOptions): string[] {
  // 自定义 scope 优先级最高
  if (options.scopes && options.scopes.length > 0) {
    // 确保包含必需 scope
    const requiredScopes = ['https://graph.microsoft.com/User.Read', 'offline_access'];
    const allScopes = [...options.scopes];
    for (const scope of requiredScopes) {
      if (!allScopes.includes(scope)) {
        allScopes.push(scope);
      }
    }
    return allScopes;
  }

  // 使用预定义服务 scope
  if (options.service && options.service in MICROSOFT_SERVICE_SCOPES) {
    return MICROSOFT_SERVICE_SCOPES[options.service];
  }

  // 默认用 Outlook scope，保持向后兼容
  return MICROSOFT_SERVICE_SCOPES.outlook;
}

/**
 * 准备 Microsoft OAuth 流程的选项（服务端，不打开浏览器）。
 */
export interface PrepareMicrosoftOAuthOptions {
  service?: MicrosoftService;
  scopes?: string[];
  /** 本地回调服务器端口（Electron）。callbackPort 和 callbackUrl 至少传一个 */
  callbackPort?: number;
  /** 完整回调 URL（WebUI）。优先级高于 callbackPort */
  callbackUrl?: string;
}

/**
 * 准备 Microsoft OAuth 流程，不启动回调服务器也不打开浏览器。
 * 返回构造授权 URL 和后续换 token 所需的一切。
 */
export function prepareMicrosoftOAuth(options: PrepareMicrosoftOAuthOptions): PreparedOAuthFlow {
  if (!isMicrosoftOAuthConfigured()) {
    throw new Error(
      'Microsoft OAuth not configured. Set MICROSOFT_OAUTH_CLIENT_ID environment variable.'
    );
  }

  const scopes = getMicrosoftScopes(options);
  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}/callback`;

  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set('client_id', MICROSOFT_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('prompt', 'consent');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: MICROSOFT_TOKEN_URL,
    clientId: MICROSOFT_CLIENT_ID,
    redirectUri,
    provider: 'microsoft',
  };
}

/**
 * 在服务端用 Microsoft 授权码换 token，并获取用户邮箱/UPN。
 */
export async function exchangeMicrosoftOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeCodeForTokens(params.code, params.codeVerifier, params.redirectUri);

    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Microsoft OAuth exchange failed',
    };
  }
}

/**
 * 启动完整的 Microsoft OAuth 流程。
 *
 * 打开浏览器展示 Microsoft 同意页，处理回调，返回 token 和邮箱。
 * 可以通过 service 指定服务，也可以传自定义 scopes。
 *
 * @example
 * // 登录 Outlook
 * const result = await startMicrosoftOAuth({ service: 'outlook' });
 *
 * @example
 * // 登录 OneDrive
 * const result = await startMicrosoftOAuth({ service: 'onedrive' });
 *
 * @example
 * // 用自定义 scope 登录
 * const result = await startMicrosoftOAuth({
 *   scopes: ['https://graph.microsoft.com/Tasks.ReadWrite']
 * });
 */
export async function startMicrosoftOAuth(
  options: MicrosoftOAuthOptions = {}
): Promise<MicrosoftOAuthResult> {
  try {
    // 检查凭据是否已配置
    if (!isMicrosoftOAuthConfigured()) {
      return {
        success: false,
        error:
          'Microsoft OAuth not configured. Set MICROSOFT_OAUTH_CLIENT_ID environment variable.',
      };
    }

    // 获取本次请求需要的 scope
    const scopes = getMicrosoftScopes(options);

    // 生成 PKCE 和 state
    const pkce = generatePKCE();
    const state = generateState();

    // 启动本地回调服务器，并带上跳回聊天 session 的 deeplink
    const appType = options.appType || 'electron';
    const deeplinkUrl = buildOAuthDeeplinkUrl(options.sessionContext);
    const callbackServer = await createCallbackServer({ appType, deeplinkUrl });
    const redirectUri = `${callbackServer.url}/callback`;

    // 构造授权 URL
    const authUrl = new URL(MICROSOFT_AUTH_URL);
    authUrl.searchParams.set('client_id', MICROSOFT_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    // response_mode=query 让授权码出现在 URL query 参数里（authorization_code 默认行为）
    authUrl.searchParams.set('response_mode', 'query');
    // prompt=consent 强制显示同意页，确保拿到 refresh token
    authUrl.searchParams.set('prompt', 'consent');

    // 打开浏览器授权
    await openUrl(authUrl.toString());

    // 等待回调
    const callback = await callbackServer.promise;

    // 校验 state
    if (callback.query.state !== state) {
      return {
        success: false,
        error: 'OAuth state mismatch - possible CSRF attack',
      };
    }

    // 检查回调错误
    if (callback.query.error) {
      return {
        success: false,
        error: callback.query.error_description || callback.query.error,
      };
    }

    // 获取授权码
    const code = callback.query.code;
    if (!code) {
      return {
        success: false,
        error: 'No authorization code received',
      };
    }

    // 用授权码换 token
    const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri);

    // 获取用户邮箱
    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during Microsoft OAuth',
    };
  }
}
