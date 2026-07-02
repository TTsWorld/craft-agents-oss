/**
 * PKCE（Proof Key for Code Exchange）工具函数
 *
 * 实现 OAuth 2.0 的 RFC 7636，用于在公共客户端（桌面/移动应用）中安全交换授权码。
 * 核心思路：先生成一个随机 verifier，再把它哈希后作为 challenge 发给授权服务器；
 * 后续换 token 时把原 verifier 传回去证明“确实是同一个客户端”。
 */

import crypto from 'crypto';

/**
 * PKCE 挑战对：verifier 是原始随机串，challenge 是 verifier 的哈希。
 */
export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * 生成一组 PKCE verifier 和 challenge。
 *
 * - verifier：32 字节密码学随机数，base64url 编码。
 * - challenge：对 verifier 做 SHA256 后再 base64url 编码。
 *
 * @returns PKCE 挑战对
 */
export function generatePKCE(): PKCEChallenge {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * 生成一个密码学安全的 state 参数，用于防止 CSRF 攻击。
 *
 * @returns 随机 state 字符串
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}
