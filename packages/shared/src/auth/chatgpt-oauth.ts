/**
 * ChatGPT OAuth with PKCE
 *
 * 实现通过 Codex app-server OAuth 端点登录 ChatGPT Plus 账号的 PKCE 流程。
 *
 * 架构：服务端主导流程（server-owned flow）。
 *   - prepareChatGptOAuth()：服务端生成 PKCE + 授权 URL
 *   - 客户端打开浏览器并运行本地回调服务器（端口 1455）
 *   - exchangeChatGptTokens()：服务端用 code 换 token
 *   - refreshChatGptTokens()：服务端刷新过期 token
 *   - exchangeIdTokenForApiKey()：把 idToken 转成 OpenAI API key
 */

import { randomBytes, createHash } from 'node:crypto';
import { CHATGPT_OAUTH_CONFIG } from './chatgpt-oauth-config.ts';

// 从共享配置里取出常量，方便本文件使用
const CLIENT_ID = CHATGPT_OAUTH_CONFIG.CLIENT_ID;
const AUTH_URL = CHATGPT_OAUTH_CONFIG.AUTH_URL;
const TOKEN_URL = CHATGPT_OAUTH_CONFIG.TOKEN_URL;
const REDIRECT_URI = CHATGPT_OAUTH_CONFIG.REDIRECT_URI;
const OAUTH_SCOPES = CHATGPT_OAUTH_CONFIG.SCOPES;

/**
 * ChatGPT OAuth 换到的 token 集合。
 */
export interface ChatGptTokens {
  /** JWT id_token，包含用户身份声明 */
  idToken: string;
  /** 用于调用 API 的 access token */
  accessToken: string;
  /** 用于刷新 token 的 refresh token */
  refreshToken?: string;
  /** token 过期时间戳（Unix 毫秒） */
  expiresAt?: number;
}

/**
 * 生成一个密码学安全的 state 参数，防止 CSRF。
 */
function generateState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * 生成 PKCE verifier 和 challenge。
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // 使用 URL-safe base64（base64url），长度 43-128 字符
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Prepare / Exchange（服务端主导流程）
// ---------------------------------------------------------------------------

/**
 * prepare 阶段返回的数据：授权 URL、state、PKCE verifier。
 */
export interface ChatGptPreparedFlow {
  authUrl: string;
  state: string;
  codeVerifier: string;
}

/**
 * 准备 ChatGPT OAuth 流程，无副作用。
 * 只返回 PKCE 参数和授权 URL；不会打开浏览器或启动回调服务器。
 *
 * 用于服务端主导流程：服务端生成参数，客户端负责打开浏览器和处理回调。
 */
export function prepareChatGptOAuth(): ChatGptPreparedFlow {
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePKCE();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
  });

  return {
    authUrl: `${AUTH_URL}?${params.toString()}`,
    state,
    codeVerifier,
  };
}

/**
 * 用授权码换 ChatGPT token（无状态）。
 * 直接传入 codeVerifier，不依赖模块级状态。
 */
export async function exchangeChatGptTokens(
  code: string,
  codeVerifier: string,
): Promise<ChatGptTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error_description || errorJson.error || errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(`Token exchange failed: ${response.status} - ${errorMessage}`);
  }

  // `as {...}` 是 TS 类型断言：告诉编译器 response.json() 的结构。
  // 类似 Go 里的类型断言 `x.(SomeType)`，但这里是编译期行为。
  const data = (await response.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * 用 refresh token 刷新 ChatGPT token。
 *
 * @param refreshToken - 上次登录得到的 refresh token
 * @param onStatus - 可选的状态回调函数
 * @returns 新的 ChatGptTokens
 */
export async function refreshChatGptTokens(
  refreshToken: string,
  onStatus?: (message: string) => void
): Promise<ChatGptTokens> {
  onStatus?.('Refreshing tokens...');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
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
      id_token: string;
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    onStatus?.('Tokens refreshed successfully!');

    return {
      idToken: data.id_token,
      accessToken: data.access_token,
      // 如果服务商返回了新 refresh token 就用新的，否则保留旧的
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Token refresh failed: ${String(error)}`);
  }
}

/**
 * 用 idToken 通过 token-exchange grant 换取 OpenAI API key。
 *
 * 实现 RFC 8693 Token Exchange：把 ChatGPT OAuth 的 idToken 转换成
 * 可以直接用于标准 OpenAI SDK 的 API key。
 *
 * @param idToken - ChatGPT OAuth 返回的 JWT id_token
 * @returns OpenAI API key 字符串
 */
export async function exchangeIdTokenForApiKey(idToken: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: CLIENT_ID,
    subject_token: idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token: 'openai-api-key',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText);
      // 兼容 error 是字符串或对象的情况
      const errorDesc = errorJson.error_description;
      const errorCode = typeof errorJson.error === 'string' ? errorJson.error : JSON.stringify(errorJson.error);
      errorMessage = errorDesc || errorCode || errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(`Token exchange failed: ${response.status} - ${errorMessage}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error('Token exchange succeeded but no access_token returned');
  }

  return data.access_token;
}
