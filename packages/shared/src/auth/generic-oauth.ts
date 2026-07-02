/**
 * 通用 OAuth 2.0（用于 API Source）
 *
 * 支持任何通过 source config.json 里的 ApiOAuthConfig 配置的 OAuth 2.0 提供商：
 * GitHub、Linear、Notion、Spotify 等。
 *
 * 所有流程都用 PKCE。同时兼容 JSON 和 application/x-www-form-urlencoded
 * 两种 token 响应格式（GitHub 默认返回 form-encoded）。
 */

import type { ApiOAuthConfig } from '../sources/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';
import { generatePKCE, generateState } from './pkce.ts';

/**
 * 解析 token 端点响应。
 *
 * 有些提供商（如 GitHub）默认返回 form-encoded，即使我们发了 Accept: application/json。
 * 所以我们先发 Accept，同时把 form-encoded 作为兜底。
 *
 * @param body - 响应体字符串
 * @param contentType - 响应 Content-Type
 * @returns 解析后的键值对象
 */
function parseTokenResponse(body: string, contentType: string | null): Record<string, string> {
  if (contentType?.includes('application/json')) {
    return JSON.parse(body);
  }
  // 先尝试按 JSON 解析（很多提供商不管 Content-Type 都返回 JSON）
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    // 不是 JSON，再按 form-urlencoded 解析
  }
  return Object.fromEntries(new URLSearchParams(body));
}

// ============================================================
// Prepare
// ============================================================

/**
 * 准备通用 OAuth 流程的选项。
 */
export interface PrepareGenericOAuthOptions {
  oauthConfig: ApiOAuthConfig;
  callbackPort?: number;
  callbackUrl?: string;
}

/**
 * 准备通用 OAuth 授权 URL。
 *
 * 生成 PKCE challenge，并把 config 里的参数全部拼进 authUrl。
 */
export function prepareGenericOAuth(options: PrepareGenericOAuthOptions): PreparedOAuthFlow {
  const { oauthConfig, callbackPort, callbackUrl } = options;
  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = callbackUrl ?? `http://localhost:${callbackPort}/callback`;

  const authUrl = new URL(oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', oauthConfig.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // scope：如果配置里有就拼进去，多个 scope 用空格分隔
  if (oauthConfig.scopes?.length) {
    authUrl.searchParams.set('scope', oauthConfig.scopes.join(' '));
  }
  // audience：部分提供商需要
  if (oauthConfig.audience) {
    authUrl.searchParams.set('audience', oauthConfig.audience);
  }
  // 额外参数：例如 access_type=offline
  if (oauthConfig.extraParams) {
    for (const [key, value] of Object.entries(oauthConfig.extraParams)) {
      authUrl.searchParams.set(key, value);
    }
  }

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.codeVerifier,
    tokenEndpoint: oauthConfig.tokenUrl,
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
    redirectUri,
    provider: 'generic',
  };
}

// ============================================================
// Exchange
// ============================================================

/**
 * 在通用 OAuth token 端点用授权码换 token。
 *
 * 兼容 JSON 和 form-urlencoded 响应。
 */
export async function exchangeGenericOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const body = new URLSearchParams({
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
    });
    if (params.clientSecret) {
      body.set('client_secret', params.clientSecret);
    }

    const response = await fetch(params.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Token exchange failed (${response.status}): ${errorText}` };
    }

    const responseBody = await response.text();
    const data = parseTokenResponse(responseBody, response.headers.get('content-type'));

    if (data.error) {
      return { success: false, error: `OAuth error: ${data.error} — ${data.error_description ?? ''}` };
    }

    const expiresIn = data.expires_in ? parseInt(data.expires_in, 10) : undefined;

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      oauthClientId: params.clientId,
      oauthClientSecret: params.clientSecret,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Generic OAuth exchange failed',
    };
  }
}

// ============================================================
// Refresh
// ============================================================

/**
 * 刷新通用 OAuth token。
 *
 * tokenUrl 和 clientId 来自 source config（不会存进凭据里），
 * clientSecret 来自已存储的凭据，如果凭据里没有则回退到 config。
 */
export async function refreshGenericOAuthToken(
  refreshToken: string,
  tokenUrl: string,
  clientId: string,
  clientSecret?: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const responseBody = await response.text();
  const data = parseTokenResponse(responseBody, response.headers.get('content-type'));

  if (data.error) {
    throw new Error(`OAuth refresh error: ${data.error} — ${data.error_description ?? ''}`);
  }

  if (!data.access_token) {
    throw new Error('Token refresh response missing access_token');
  }

  const expiresIn = data.expires_in ? parseInt(data.expires_in, 10) : undefined;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
  };
}
