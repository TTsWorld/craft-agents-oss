/**
 * Claude OAuth token 刷新与过期检查
 *
 * 负责用 refresh_token 向 Claude 平台换新的 access_token，
 * 并提供 token 是否即将过期的工具函数。
 */

import { CLAUDE_OAUTH_CONFIG } from './claude-oauth-config';
import { APP_VERSION } from '../version/index.ts';
import { debug } from '../utils/debug.ts';

/**
 * 已存储的 Claude OAuth 凭据结构。
 */
export interface ClaudeOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

/**
 * 用 refresh token 刷新 Claude OAuth token。
 *
 * 使用 Claude platform OAuth token 端点（和换 token 是同一个端点）。
 *
 * @param refreshToken - 上次登录得到的 refresh token
 * @returns 新的 accessToken/refreshToken/expiresAt
 */
export async function refreshClaudeToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}> {
  // 和 token exchange 端点保持一致，使用 JSON 格式
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CONFIG.CLIENT_ID,
  };

  const response = await fetch(CLAUDE_OAUTH_CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `CraftAgents/${APP_VERSION}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    let errorText: string;
    try {
      errorText = await response.text();
    } catch {
      errorText = `HTTP ${response.status} ${response.statusText}`;
    }

    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error_description || errorJson.error || errorText;
    } catch {
      errorMessage = errorText;
    }

    throw new Error(`Token refresh failed: ${response.status} - ${errorMessage}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  // 记录 API 返回的过期信息，便于排查问题
  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : undefined;
  debug(`[claude-token] Refresh response - expires_in: ${data.expires_in ?? 'NOT PROVIDED'}, calculated expiresAt: ${expiresAt ? new Date(expiresAt).toISOString() : 'undefined'}`);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
  };
}

/**
 * 检查 token 是否已经过期或将在 5 分钟内过期。
 *
 * @param expiresAt - token 过期时间戳（毫秒）
 * @returns true 表示已过期或即将过期
 */
export function isTokenExpired(expiresAt?: number): boolean {
  if (!expiresAt) {
    // 没有过期时间，认为仍然有效
    return false;
  }
  // 预留 5 分钟缓冲，避免在临界点附近失败
  const bufferMs = 5 * 60 * 1000;
  return Date.now() + bufferMs >= expiresAt;
}
