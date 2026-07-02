/**
 * OAuth Relay 状态编码/解码工具
 *
 * 当客户端无法直接接收 HTTP localhost 回调时（例如 WebUI、远端主机），
 * 用一个公共 relay（agents.craft.do/auth/callback）统一接收回调，
 * 再通过 state 里的 returnTo 把请求路由回真正的客户端。
 */

import type { PreparedOAuthFlow } from './oauth-flow-types.ts';

/** 公共 relay 回调地址 */
export const OAUTH_RELAY_CALLBACK_URL = 'https://agents.craft.do/auth/callback';
/** state 前缀，用于识别这是 relay 封装的 state */
const OAUTH_RELAY_STATE_PREFIX = 'ca1.';
/** state 格式版本号，方便未来做兼容 */
const OAUTH_RELAY_STATE_VERSION = 1;

/**
 * relay state 信封结构：
 * - v: 版本号
 * - r: 最终要返回给哪个客户端（returnTo）
 * - s: 原始内部 state
 */
interface OAuthRelayStateEnvelope {
  v: number;
  r: string;
  s: string;
}

/** 解码后的 relay state */
export interface OAuthRelayState {
  returnTo: string;
  innerState: string;
}

/** 把字符串转成 base64url（浏览器安全，不用 Buffer） */
function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** 把 base64url 还原成字符串 */
function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 判断一个 state 是否是被 relay 封装过的 */
export function isOAuthRelayState(value: string): boolean {
  return value.startsWith(OAUTH_RELAY_STATE_PREFIX);
}

/**
 * 把 returnTo 和内部 state 编码成一个 relay state 字符串。
 *
 * 最终格式：ca1.{base64url(JSON.stringify(envelope))}
 */
export function encodeOAuthRelayState(returnTo: string, innerState: string): string {
  const envelope: OAuthRelayStateEnvelope = {
    v: OAUTH_RELAY_STATE_VERSION,
    r: returnTo,
    s: innerState,
  };
  return `${OAUTH_RELAY_STATE_PREFIX}${toBase64Url(JSON.stringify(envelope))}`;
}

/**
 * 解码 relay state，还原 returnTo 和内部 state。
 * 如果格式/版本/字段不对会抛错。
 */
export function decodeOAuthRelayState(value: string): OAuthRelayState {
  if (!isOAuthRelayState(value)) {
    throw new Error('State does not use the OAuth relay envelope');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value.slice(OAUTH_RELAY_STATE_PREFIX.length)));
  } catch {
    throw new Error('Invalid OAuth relay state');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('v' in parsed) || parsed.v !== OAUTH_RELAY_STATE_VERSION ||
    !('r' in parsed) || typeof parsed.r !== 'string' || parsed.r.length === 0 ||
    !('s' in parsed) || typeof parsed.s !== 'string' || parsed.s.length === 0
  ) {
    throw new Error('Invalid OAuth relay state');
  }

  return {
    returnTo: parsed.r,
    innerState: parsed.s,
  };
}

/**
 * 把一个 prepare 好的 OAuth 流程包装成 relay 模式。
 * 会把 redirect_uri 改成公共 relay 地址，并把 state 替换为封装后的 relay state。
 */
export function wrapPreparedOAuthFlowForRelay(
  prepared: PreparedOAuthFlow,
  returnTo: string,
): PreparedOAuthFlow {
  const authUrl = new URL(prepared.authUrl);
  authUrl.searchParams.set('redirect_uri', OAUTH_RELAY_CALLBACK_URL);
  authUrl.searchParams.set('state', encodeOAuthRelayState(returnTo, prepared.state));

  return {
    ...prepared,
    authUrl: authUrl.toString(),
    redirectUri: OAUTH_RELAY_CALLBACK_URL,
  };
}
