/**
 * auth-validation.ts — 认证信息校验工具
 *
 * 所属目录：renderer/utils
 * 运行环境：Electron 的 renderer（渲染）进程，即前端界面层。
 *         它不能直接使用 Node.js 的 fs/net 等原生能力；如需访问主进程，
 *         应通过 preload 注入的 IPC 通道调用 main 进程（类似 Go 里通过 RPC 调用服务）。
 * 作用：校验 Basic Auth 凭据，并统一处理密码字段的提交值、标签、占位文案。
 *       被 CredentialRequest 与 AuthRequestCard 等组件复用。
 */

/**
 * 校验 Basic Auth 凭据是否有效。
 *
 * @param username - 用户名或 API Key
 * @param password - 密码
 * @param passwordRequired - 是否必须填写密码（默认为 true，保持向后兼容）
 * @returns 凭据有效返回 true，否则返回 false
 */
export function validateBasicAuthCredentials(
  username: string,
  password: string,
  passwordRequired: boolean = true
): boolean {
  const hasUsername = username.trim().length > 0
  const hasPassword = password.trim().length > 0

  return passwordRequired
    ? hasUsername && hasPassword  // 用户名与密码都需要
    : hasUsername                  // 只需要用户名
}

/**
 * 获取最终需要提交的密码值。
 * 当密码非必填时，无论输入框内容如何，都提交空字符串。
 *
 * @param password - 密码输入框当前值
 * @param passwordRequired - 是否必须填写密码
 * @returns 实际提交的密码（trim 后或空字符串）
 */
export function getPasswordValue(
  password: string,
  passwordRequired: boolean = true
): string {
  return passwordRequired ? password.trim() : ''
}

/**
 * 根据密码是否必填，生成带可选后缀的标签。
 *
 * @param baseLabel - 基础标签，例如 "Password"
 * @param passwordRequired - 是否必须填写密码
 * @returns 必填时返回 baseLabel，否则返回 "{baseLabel} (optional)"
 */
export function getPasswordLabel(
  baseLabel: string,
  passwordRequired: boolean = true
): string {
  return passwordRequired ? baseLabel : `${baseLabel} (optional)`
}

/**
 * 获取密码输入框的占位提示文案。
 *
 * @param baseLabel - 基础标签，例如 "Password"
 * @param passwordRequired - 是否必须填写密码
 * @returns 对应的 placeholder 文案
 */
export function getPasswordPlaceholder(
  baseLabel: string,
  passwordRequired: boolean = true
): string {
  return passwordRequired
    ? `Enter ${baseLabel.toLowerCase()}`
    : 'Optional - leave blank'
}
