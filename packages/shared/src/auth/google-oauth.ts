/**
 * Google OAuth 流程
 *
 * 使用 Google OAuth 2.0 with PKCE，处理完整登录流程：
 * 1. 打开浏览器展示 Google 同意页
 * 2. 通过本地回调服务器接收授权码
 * 3. 用授权码换 access/refresh token
 * 4. 返回 token 和用户邮箱
 *
 * 支持多种 Google 服务（Gmail、Calendar、Drive 等）的预定义 scope，也支持自定义 scope。
 */

import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { createCallbackServer, type AppType } from './callback-server.ts';
import { type GoogleService } from '../sources/types.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';

// 为了调用方便，再导出一次 GoogleService 类型
export type { GoogleService };

// Google OAuth 配置：环境变量作为兜底
// 推荐在 source config 里提供自己的凭据（对 OSS 更友好）
// 注意：Google 桌面应用即便支持 PKCE，也要求提供 client_secret
const GOOGLE_CLIENT_ID_ENV = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET_ENV = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

// Google OAuth 端点
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * 常见 Google 服务的预定义 scope 集合。
 * key 是服务名，value 是该服务需要的 scope 数组。
 */
export const GOOGLE_SERVICE_SCOPES: Record<GoogleService, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify', // 读、删、打标签、标记已读/未读
    'https://www.googleapis.com/auth/gmail.compose', // 创建和发送草稿
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar', // 完整日历访问
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  drive: [
    'https://www.googleapis.com/auth/drive', // 完整 Drive 访问
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  docs: [
    'https://www.googleapis.com/auth/documents', // 完整 Docs 访问
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  sheets: [
    'https://www.googleapis.com/auth/spreadsheets', // 完整 Sheets 访问
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  youtube: [
    'https://www.googleapis.com/auth/youtube.readonly', // 读取频道、视频、播放列表
    'https://www.googleapis.com/auth/youtube.force-ssl', // 管理内容（评论、播放列表等）
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  searchconsole: [
    'https://www.googleapis.com/auth/webmasters.readonly', // 读取 Search Console 数据
    'https://www.googleapis.com/auth/userinfo.email',
  ],
};

/**
 * 启动 Google OAuth 流程的选项。
 */
export interface GoogleOAuthOptions {
  /** 要登录的 Google 服务（使用预定义 scope） */
  service?: GoogleService;
  /** 自定义 scope（提供时覆盖 service 的 scope） */
  scopes?: string[];
  /** 回调页面样式 */
  appType?: AppType;
  /** OAuth client ID（用户提供的，回退到环境变量） */
  clientId?: string;
  /** OAuth client secret（用户提供的，回退到环境变量） */
  clientSecret?: string;
  /** OAuth 完成后跳回聊天 session 的上下文 */
  sessionContext?: OAuthSessionContext;
}

/**
 * Google OAuth 流程结果。
 */
export interface GoogleOAuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  error?: string;
  /** 存储 token 时一起保存的 clientId（Google 刷新需要） */
  clientId?: string;
  /** 存储 token 时一起保存的 clientSecret（Google 刷新需要） */
  clientSecret?: string;
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
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
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
 * 用 access token 获取用户邮箱。
 */
async function getUserEmail(accessToken: string): Promise<string> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  const data = (await response.json()) as { email: string };
  return data.email;
}

/**
 * 用 refresh token 刷新 Google access token。
 *
 * @param refreshToken - 初始 OAuth 得到的 refresh token
 * @param clientId - OAuth client ID（未提供时回退到环境变量）
 * @param clientSecret - OAuth client secret（未提供时回退到环境变量）
 */
export async function refreshGoogleToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string
): Promise<{
  accessToken: string;
  expiresAt?: number;
}> {
  const id = clientId || GOOGLE_CLIENT_ID_ENV;
  const secret = clientSecret || GOOGLE_CLIENT_SECRET_ENV;

  if (!id || !secret) {
    throw new Error(
      'Google OAuth credentials not available for token refresh. ' +
        'Credentials must be stored with the token or set via environment variables.'
    );
  }

  const params = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error('Failed to refresh Google token');
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * 检查 Google OAuth 是否已配置（clientId 和 clientSecret 至少有一个来源可用）。
 *
 * @param clientId - 可选的用户提供的 client ID
 * @param clientSecret - 可选的用户提供的 client secret
 * @returns true 表示凭据可用
 */
export function isGoogleOAuthConfigured(clientId?: string, clientSecret?: string): boolean {
  const id = clientId || GOOGLE_CLIENT_ID_ENV;
  const secret = clientSecret || GOOGLE_CLIENT_SECRET_ENV;
  return Boolean(id && secret);
}

/**
 * 根据 service 或自定义 scopes 获取最终要请求的 scope 列表。
 */
export function getGoogleScopes(options: GoogleOAuthOptions): string[] {
  // 自定义 scope 优先级最高
  if (options.scopes && options.scopes.length > 0) {
    // 确保包含 userinfo.email，否则后面拿不到邮箱
    const emailScope = 'https://www.googleapis.com/auth/userinfo.email';
    if (!options.scopes.includes(emailScope)) {
      return [...options.scopes, emailScope];
    }
    return options.scopes;
  }

  // 使用预定义的服务 scope
  if (options.service && options.service in GOOGLE_SERVICE_SCOPES) {
    return GOOGLE_SERVICE_SCOPES[options.service];
  }

  // 默认用 Gmail scope，保持向后兼容
  return GOOGLE_SERVICE_SCOPES.gmail;
}

/**
 * 准备 Google OAuth 流程的选项（服务端，不打开浏览器）。
 */
export interface PrepareGoogleOAuthOptions {
  service?: GoogleService;
  scopes?: string[];
  /** 本地回调服务器端口（Electron）。callbackPort 和 callbackUrl 至少传一个 */
  callbackPort?: number;
  /** 完整回调 URL（WebUI）。优先级高于 callbackPort */
  callbackUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * 准备 Google OAuth 流程，不启动回调服务器也不打开浏览器。
 * 返回构造授权 URL 和后续换 token 所需的一切。
 */
export function prepareGoogleOAuth(options: PrepareGoogleOAuthOptions): PreparedOAuthFlow {
  const clientId = options.clientId || GOOGLE_CLIENT_ID_ENV;
  const clientSecret = options.clientSecret || GOOGLE_CLIENT_SECRET_ENV;

  if (!isGoogleOAuthConfigured(clientId, clientSecret)) {
    throw new Error(
      'Google OAuth not configured. Provide clientId and clientSecret in source config, ' +
      'or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables.'
    );
  }

  const scopes = getGoogleScopes(options);
  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}/callback`;

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: GOOGLE_TOKEN_URL,
    clientId,
    clientSecret,
    redirectUri,
    provider: 'google',
  };
}

/**
 * 在服务端用 Google 授权码换 token，并获取用户邮箱。
 */
export async function exchangeGoogleOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeCodeForTokens(
      params.code,
      params.codeVerifier,
      params.redirectUri,
      params.clientId,
      params.clientSecret || ''
    );

    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
      oauthClientId: params.clientId,
      oauthClientSecret: params.clientSecret,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Google OAuth exchange failed',
    };
  }
}

/**
 * 启动完整的 Google OAuth 流程。
 *
 * 打开浏览器展示 Google 同意页，处理回调，返回 token 和邮箱。
 * 可以通过 service 指定服务，也可以传自定义 scopes。
 *
 * @example
 * // 登录 Gmail
 * const result = await startGoogleOAuth({ service: 'gmail' });
 *
 * @example
 * // 登录 Google Calendar
 * const result = await startGoogleOAuth({ service: 'calendar' });
 *
 * @example
 * // 用自定义 scope 登录
 * const result = await startGoogleOAuth({
 *   scopes: ['https://www.googleapis.com/auth/spreadsheets']
 * });
 */
export async function startGoogleOAuth(
  options: GoogleOAuthOptions = {}
): Promise<GoogleOAuthResult> {
  try {
    // 解析凭据：优先用传入值，否则回退环境变量
    const clientId = options.clientId || GOOGLE_CLIENT_ID_ENV;
    const clientSecret = options.clientSecret || GOOGLE_CLIENT_SECRET_ENV;

    // 检查凭据是否已配置
    if (!isGoogleOAuthConfigured(clientId, clientSecret)) {
      return {
        success: false,
        error:
          'Google OAuth not configured. Provide clientId and clientSecret in source config, ' +
          'or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables.',
      };
    }

    // 获取本次请求需要的 scope
    const scopes = getGoogleScopes(options);

    // 生成 PKCE 和 state
    const pkce = generatePKCE();
    const state = generateState();

    // 启动本地回调服务器，并带上跳回聊天 session 的 deeplink
    const appType = options.appType || 'electron';
    const deeplinkUrl = buildOAuthDeeplinkUrl(options.sessionContext);
    const callbackServer = await createCallbackServer({ appType, deeplinkUrl });
    const redirectUri = `${callbackServer.url}/callback`;

    // 构造授权 URL
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline'); // 请求 refresh token
    authUrl.searchParams.set('prompt', 'consent'); // 每次都显示同意页，确保拿到 refresh token

    // 打开浏览器授权
    await openUrl(authUrl.toString());

    // 等待回调
    const callback = await callbackServer.promise;

    // 校验 state，防止 CSRF
    if (callback.query.state !== state) {
      return {
        success: false,
        error: 'OAuth state mismatch - possible CSRF attack',
      };
    }

    // 检查回调里是否有错误
    if (callback.query.error) {
      const isAccessBlocked =
        callback.query.error === 'access_denied' &&
        String(callback.query.error_description ?? '').toLowerCase().includes('verif');
      const error = isAccessBlocked
        ? 'Google has blocked this app (not yet verified).\n\n' +
          'To fix this, add your own Google OAuth credentials to the source config:\n' +
          '  "googleOAuthClientId": "...",\n' +
          '  "googleOAuthClientSecret": "..."\n\n' +
          'See: https://console.cloud.google.com/apis/credentials'
        : callback.query.error_description || callback.query.error;
      return { success: false, error };
    }

    // 获取授权码
    const code = callback.query.code;
    if (!code) {
      return {
        success: false,
        error: 'No authorization code received',
      };
    }

    // 用授权码换 token（传凭据用于 token exchange）
    const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri, clientId, clientSecret);

    // 获取用户邮箱
    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
      // 把凭据一起返回，方便存下来用于后续刷新
      clientId,
      clientSecret,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during Google OAuth',
    };
  }
}
