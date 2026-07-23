/**
 * 供 WebUI 和 Viewer 使用的浏览器端外部 URL 打开器。
 *
 * 在跨源 HTTPS 上下文中，`window.open(url, '_blank', 'noopener,noreferrer')`
 * 对非 http 协议不可靠：Chrome 会打开一个分离标签页，永远无法触达
 * 外部协议分发器，且 URL 最终会被改写为相对于当前源的形式
 * （例如 `https://<host>/obsidian://foo` → 404）。
 *
 * 而对 DOM 中真实 `<a>` 的普通锚点点击会走链接导航路径，
 * 从而触发操作系统协议处理器的提示。我们对 http/https 仍保留
 * `window.open`，以使新标签页的体验与当前保持一致。
 */

import {
  classifyExternalUrl,
  type UrlClassification,
} from '@craft-agent/shared/utils/url-safety'

export type OpenExternalUrlResult =
  | { opened: true }
  | { opened: false; reason: 'dangerous'; detail: string }
  | { opened: false; reason: 'internal-deeplink' }
  | { opened: false; reason: 'malformed' }

export function openExternalUrl(rawUrl: string): OpenExternalUrlResult {
  const classification: UrlClassification = classifyExternalUrl(rawUrl)

  if (classification.kind === 'dangerous') {
    return { opened: false, reason: 'dangerous', detail: classification.reason }
  }

  if (classification.kind === 'internal-deeplink') {
    return { opened: false, reason: 'internal-deeplink' }
  }

  const url = rawUrl.trim()

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { opened: false, reason: 'malformed' }
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    window.open(url, '_blank', 'noopener,noreferrer')
    return { opened: true }
  }

  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
  return { opened: true }
}
