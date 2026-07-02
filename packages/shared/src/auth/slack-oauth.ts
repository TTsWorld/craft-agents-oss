/**
 * Slack OAuth 流程
 *
 * 使用 Slack OAuth 2.0 v2 进行用户认证（USER authentication）：
 * 1. 打开浏览器展示 Slack 同意页
 * 2. 通过本地回调服务器接收授权码
 * 3. 用授权码换用户 access token
 * 4. 返回 token 和工作区信息
 *
 * 使用 user_scope（不是 scope）来以用户身份认证，而不是以 bot 身份安装应用。
 * 这样可以以“你自己”的名义发消息。
 */

import { URL } from 'url';
import { randomBytes } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { createCallbackServer, type AppType } from './callback-server.ts';
import type { SlackService } from '../sources/types.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';

// 再导出一次 SlackService 类型，方便外部使用
export type { SlackService } from '../sources/types.ts';

// Slack OAuth 配置：通过环境变量注入，编译时固化
const SLACK_CLIENT_ID = process.env.SLACK_OAUTH_CLIENT_ID || '';
const SLACK_CLIENT_SECRET = process.env.SLACK_OAUTH_CLIENT_SECRET || '';

// Slack OAuth 端点
const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

/**
 * 常见 Slack 服务的预定义用户 scope 集合。
 *
 * 这些是 user_scope，不是 bot scope。
 * user_scope 允许以认证用户的身份操作。
 */
export const SLACK_SERVICE_SCOPES: Record<SlackService, string[]> = {
  messaging: ['chat:write'],
  channels: ['channels:read', 'channels:history', 'groups:read', 'groups:history'],
  users: ['users:read', 'users:read.email'],
  files: ['files:read', 'files:write'],
  full: [
    'chat:write',
    'channels:read',
    'channels:history',
    'groups:read',
    'groups:history',
    'users:read',
    'users:read.email',
    'files:read',
    'files:write',
    'reactions:read',
    'reactions:write',
    'im:read',
    'im:history',
    'im:write',
    'mpim:read',
    'mpim:history',
    'search:read',
  ],
};

/**
 * 启动 Slack OAuth 流程的选项。
 */
export interface SlackOAuthOptions {
  /** 要登录的 Slack 服务（使用预定义 scope） */
  service?: SlackService;
  /** 自定义用户 scope（提供时覆盖 service 的 scope） */
  userScopes?: string[];
  /** 回调页面样式 */
  appType?: AppType;
  /** OAuth 完成后跳回聊天 session 的上下文 */
  sessionContext?: OAuthSessionContext;
}

/**
 * Slack OAuth 流程结果。
 */
export interface SlackOAuthResult {
  success: boolean;
  /** 用户 access token（xoxp-...），用于以用户身份操作 */
  accessToken?: string;
  /** 如果 Slack 应用启用了 token rotation，则有 refresh token */
  refreshToken?: string;
  /** token 过期时间戳（毫秒），仅启用 token rotation 时存在 */
  expiresAt?: number;
  /** Slack 工作区 ID */
  teamId?: string;
  /** Slack 工作区名称 */
  teamName?: string;
  /** 认证用户 ID */
  userId?: string;
  /** 失败时的错误信息 */
  error?: string;
}

/**
 * 生成随机 state，防止 CSRF。
 */
function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 用授权码换 token。
 * Slack token exchange 使用 HTTP Basic auth。
 */
async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  teamId: string;
  teamName: string;
  userId: string;
}> {
  // Slack 推荐用 HTTP Basic auth：client_id:client_secret 做 base64
  const authHeader = Buffer.from(`${SLACK_CLIENT_ID}:${SLACK_CLIENT_SECRET}`).toString('base64');

  const params = new URLSearchParams({
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authHeader}`,
    },
    body: params.toString(),
  });

  const data = (await response.json()) as {
    ok: boolean;
    error?: string;
    // 用户 token 在 authed_user 里
    authed_user?: {
      id: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    team?: { id: string; name: string };
  };

  if (!data.ok) {
    throw new Error(`Slack token exchange failed: ${data.error || 'Unknown error'}`);
  }

  // 用户 token 在 authed_user.access_token
  if (!data.authed_user?.access_token) {
    throw new Error('No user access token received. Make sure user_scope is set in the OAuth request.');
  }

  return {
    accessToken: data.authed_user.access_token,
    refreshToken: data.authed_user.refresh_token,
    expiresIn: data.authed_user.expires_in,
    teamId: data.team?.id || '',
    teamName: data.team?.name || '',
    userId: data.authed_user.id,
  };
}

/**
 * 用 refresh token 刷新 Slack access token。
 * 注意：需要在 Slack 应用设置里启用 token rotation 才会有 refresh token。
 */
export async function refreshSlackToken(
  refreshToken: string,
  clientId?: string
): Promise<{ accessToken: string; expiresAt?: number }> {
  const authHeader = Buffer.from(
    `${clientId || SLACK_CLIENT_ID}:${SLACK_CLIENT_SECRET}`
  ).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authHeader}`,
    },
    body: params.toString(),
  });

  const data = (await response.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    expires_in?: number;
  };

  if (!data.ok) {
    throw new Error(`Failed to refresh Slack token: ${data.error}`);
  }

  return {
    accessToken: data.access_token!,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * 检查 Slack OAuth 是否已配置（client ID 和 secret 都已设置）。
 */
export function isSlackOAuthConfigured(): boolean {
  return Boolean(SLACK_CLIENT_ID && SLACK_CLIENT_SECRET);
}

/**
 * 根据 service 或自定义 userScopes 获取最终 scope 列表。
 */
export function getSlackScopes(options: SlackOAuthOptions): string[] {
  // 自定义 scope 优先级最高
  if (options.userScopes && options.userScopes.length > 0) {
    return options.userScopes;
  }

  // 使用预定义服务 scope
  if (options.service && options.service in SLACK_SERVICE_SCOPES) {
    return SLACK_SERVICE_SCOPES[options.service];
  }

  // 默认用完整工作区 scope
  return SLACK_SERVICE_SCOPES.full;
}

/**
 * 准备 Slack OAuth 流程的选项（服务端，不打开浏览器）。
 */
export interface PrepareSlackOAuthOptions {
  service?: SlackService;
  userScopes?: string[];
  /** 本地回调服务器端口（Electron）。callbackPort 和 callbackUrl 至少传一个 */
  callbackPort?: number;
  /** 完整回调 URL（WebUI）。优先级高于 callbackPort */
  callbackUrl?: string;
}

/**
 * 准备 Slack OAuth 流程，不启动回调服务器也不打开浏览器。
 * 返回构造授权 URL 和后续换 token 所需的一切。
 *
 * 由于 Slack 要求 HTTPS 回调地址，本地场景下使用 Cloudflare relay。
 */
export function prepareSlackOAuth(options: PrepareSlackOAuthOptions): PreparedOAuthFlow {
  if (!isSlackOAuthConfigured()) {
    throw new Error(
      'Slack OAuth not configured. Set SLACK_OAUTH_CLIENT_ID and SLACK_OAUTH_CLIENT_SECRET environment variables.'
    );
  }

  const userScopes = getSlackScopes(options);
  const state = generateState();

  // Slack 要求 HTTPS；使用 callbackPort 时通过 Cloudflare relay 转发
  const redirectUri = options.callbackUrl
    ?? `https://agents.craft.do/auth/slack/callback?port=${options.callbackPort}`;

  const authUrl = new URL(SLACK_AUTH_URL);
  authUrl.searchParams.set('client_id', SLACK_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('user_scope', userScopes.join(','));

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: '',  // Slack 不使用 PKCE
    tokenEndpoint: SLACK_TOKEN_URL,
    clientId: SLACK_CLIENT_ID,
    clientSecret: SLACK_CLIENT_SECRET,
    redirectUri,
    provider: 'slack',
  };
}

/**
 * 在服务端用 Slack 授权码换 token。
 * Slack 使用 HTTP Basic auth（client_id:client_secret）做 token exchange。
 */
export async function exchangeSlackOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeCodeForTokens(params.code, params.redirectUri);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email: tokens.teamName,  // 用 teamName 作为标识字段
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Slack OAuth exchange failed',
    };
  }
}

/**
 * 启动完整的 Slack 用户认证流程。
 *
 * 打开浏览器展示 Slack 同意页，处理回调，返回用户 token 和工作区信息。
 * 使用 user_scope 以用户身份认证（不是安装 bot），允许以你自己的名义发消息。
 *
 * @example
 * // 用完整工作区权限登录
 * const result = await startSlackOAuth({ service: 'full' });
 *
 * @example
 * // 只请求消息权限
 * const result = await startSlackOAuth({ service: 'messaging' });
 *
 * @example
 * // 用自定义 scope 登录
 * const result = await startSlackOAuth({
 *   userScopes: ['chat:write', 'users:read']
 * });
 */
export async function startSlackOAuth(options: SlackOAuthOptions = {}): Promise<SlackOAuthResult> {
  try {
    // 检查凭据是否已配置
    if (!isSlackOAuthConfigured()) {
      return {
        success: false,
        error:
          'Slack OAuth not configured. Set SLACK_OAUTH_CLIENT_ID and SLACK_OAUTH_CLIENT_SECRET environment variables.',
      };
    }

    // 获取本次请求需要的用户 scope
    const userScopes = getSlackScopes(options);

    // 生成 state，防止 CSRF
    const state = generateState();

    // 启动本地 HTTP 回调服务器，并带上跳回聊天 session 的 deeplink
    const appType = options.appType || 'electron';
    const deeplinkUrl = buildOAuthDeeplinkUrl(options.sessionContext);
    const callbackServer = await createCallbackServer({ appType, deeplinkUrl });

    // 从本地回调 URL 里取出端口
    const localUrl = new URL(callbackServer.url);
    const port = localUrl.port;

    // 使用 Cloudflare Worker relay 处理 Slack OAuth（Slack 要求 HTTPS）
    // relay 会把 https://agents.craft.do/auth/slack/callback 重定向到 http://localhost:{port}/callback
    const redirectUri = `https://agents.craft.do/auth/slack/callback?port=${port}`;

    // 构造授权 URL
    // 用 user_scope（不是 scope）来获取用户 token，而不是 bot token
    const authUrl = new URL(SLACK_AUTH_URL);
    authUrl.searchParams.set('client_id', SLACK_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    // user_scope = 以用户身份认证；scope = 安装 bot
    authUrl.searchParams.set('user_scope', userScopes.join(','));

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
    const tokens = await exchangeCodeForTokens(code, redirectUri);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      teamId: tokens.teamId,
      teamName: tokens.teamName,
      userId: tokens.userId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during Slack OAuth',
    };
  }
}
