/**
 * 外部 URL 分类工具，用于 shell.openExternal 风格的处理器。
 *
 * 采用黑名单而非白名单：操作系统只会分发已注册处理程序的 URL scheme，
 * 因此 obsidian://、vscode:// 等实际上可以安全透传。
 * 已知危险的 scheme（XSS 原语以及 Windows 上可作为 RCE 向量的 file:）
 * 被显式拦截，并附带每条 scheme 的原因，方便给用户展示有意义的提示。
 */

/**
 * URL 分类结果。
 * TS 中的 `type` 是“类型别名”，这里用联合类型表示三种互斥结果。
 * 类比 Go：类似一个只有一个字段区分的 interface/struct 联合。
 */
export type UrlClassification =
  | { kind: 'dangerous'; scheme?: string; reason: string }
  | { kind: 'internal-deeplink' }
  | { kind: 'safe-external' }

/**
 * 被拦截的 URL scheme（包含尾部 `:`）到可读原因的映射。
 * 原因会展示给用户，因此应解释“为什么”而不只是“是什么”。
 */
const DANGEROUS_SCHEMES: ReadonlyMap<string, string> = new Map([
  ['javascript:', 'JavaScript URLs can execute arbitrary code in the renderer (XSS vector).'],
  ['data:', 'data: URLs can embed executable content and bypass scheme restrictions.'],
  ['vbscript:', 'VBScript URLs are a legacy script-execution vector.'],
  ['blob:', 'blob: URLs are renderer-scoped and do not resolve outside this window.'],
  [
    'file:',
    'file: URLs are blocked because shell.openExternal can launch local executables on Windows (Electron RCE class). Use an in-app preview block (html-preview, pdf-preview, image-preview, markdown-preview) or open the file from your OS file manager.',
  ],
])

const INTERNAL_DEEPLINK_SCHEME = 'craftagents:'

/**
 * 对外部 URL 进行分类。
 *
 * @param rawUrl - 原始 URL 字符串
 * @returns UrlClassification，说明 URL 是危险、内部深链还是安全外部链接
 */
export function classifyExternalUrl(rawUrl: string): UrlClassification {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { kind: 'dangerous', reason: 'URL is empty or whitespace-only.' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { kind: 'dangerous', reason: 'URL is malformed and cannot be parsed.' }
  }

  const protocol = parsed.protocol.toLowerCase()

  const blockedReason = DANGEROUS_SCHEMES.get(protocol)
  if (blockedReason) {
    return { kind: 'dangerous', scheme: protocol, reason: blockedReason }
  }

  if (protocol === INTERNAL_DEEPLINK_SCHEME) {
    return { kind: 'internal-deeplink' }
  }

  return { kind: 'safe-external' }
}

/**
 * 判断 URL 是否为安全的外部 URL。
 */
export function isSafeExternalUrl(rawUrl: string): boolean {
  return classifyExternalUrl(rawUrl).kind === 'safe-external'
}

/**
 * 将 `dangerous` 分类格式化为面向用户的错误信息。
 * 非危险分类返回空字符串。
 */
export function formatBlockedUrlError(classification: UrlClassification): string {
  if (classification.kind !== 'dangerous') return ''
  const suffix = classification.scheme ? ` (${classification.scheme})` : ''
  return `URL blocked${suffix}. ${classification.reason}`
}
