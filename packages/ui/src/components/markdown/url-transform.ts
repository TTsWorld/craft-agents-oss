import { defaultUrlTransform, type UrlTransform } from 'react-markdown'

export const markdownUrlTransform: UrlTransform = (value, key, node) => {
  const tagName = typeof node === 'object' && node && 'tagName' in node
    ? String((node as { tagName?: unknown }).tagName)
    : ''

  // ReactMarkdown 的默认转换会在自定义组件接收 props 之前
  // 去除 file:/javascript:/data:。对于锚点，保留原始目标，
  // 以便自定义 <a> 能通过 onFileClick/onUrlClick 路由常规点击，
  // 同时仍写入单独净化过的 DOM href。对图片和其他所有承载 URL 的属性
  // 保持默认净化。
  if (key === 'href' && tagName === 'a') return value
  return defaultUrlTransform(value)
}
