/**
 * 在外部浏览器中打开 label 的 `link` 类型值。
 *
 * link 值按用户输入原样存储，不会在保存时改写，因此像 "example.com" 这样的裸主机没有协议。
 * `shell:openUrl` IPC 只接受 http/https/mailto，所以无协议值会在这里统一加上 `https://`，
 * 在打开时做规范化。
 *
 * 这是该规范化逻辑的唯一负责人：SessionList、ChatDisplay、聊天输入、value popover
 * 等所有 label 表面都调用它，避免不同地方的前缀规则不一致。
 */
export function openLabelLink(rawValue: string): void {
  const trimmed = rawValue.trim()
  if (!trimmed) return

  // 已有协议（https://、http://、mailto:）则原样打开；否则视为裸 URL，默认加 https://
  const hasProtocol = /^[a-z][\w+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('mailto:')
  const url = hasProtocol ? trimmed : `https://${trimmed}`

  void window.electronAPI.openUrl(url).catch((err) => {
    console.error('[openLabelLink] 打开 URL 失败：', url, err)
  })
}
