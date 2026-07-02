/**
 * 凭据脱敏工具
 *
 * 提供一致的敏感凭据展示脱敏。
 */

/**
 * 凭据类型别名。
 * TS 的 `type` 类似 Go 的 type alias（如 type CredentialType = string 的受限版）。
 */
export type CredentialType = 'api_key' | 'oauth_token' | 'generic';

/**
 * 脱敏选项接口。
 * TS 的 `interface` 类似 Go 的 interface，但这里用于描述对象结构（更像 struct）。
 */
export interface MaskOptions {
  /** 凭据类型，用于按类型脱敏 */
  type?: CredentialType;
  /** 值为 null/undefined 时显示的文本 */
  notSetText?: string;
}

/**
 * 对凭据值进行安全展示脱敏。
 *
 * - API key（sk-ant-...）：显示前 7 位 + 后 4 位
 * - OAuth token：显示前 3 位 + 后 3 位
 * - 通用/未知：显示前 3 位 + 后 3 位
 * - null/undefined：返回 notSetText（默认 '(not set)'）
 * - 短值：返回星号
 *
 * @param value - 待脱敏的凭据值
 * @param options - 脱敏选项
 * @returns 脱敏后的字符串
 */
export function maskCredential(
  value: string | undefined | null,
  options: MaskOptions = {}
): string {
  const { type = 'generic', notSetText = '(not set)' } = options;

  if (!value) {
    return notSetText;
  }

  // API key 特殊处理：保留可识别前缀
  if (type === 'api_key') {
    if (value.length > 11) {
      return `${value.slice(0, 7)}...${value.slice(-4)}`;
    }
    if (value.length > 4) {
      return `${value.slice(0, 4)}...`;
    }
    return '******';
  }

  // OAuth token 与通用凭据
  if (value.length > 6) {
    return `${value.slice(0, 3)}...${value.slice(-3)}`;
  }

  return '******';
}
