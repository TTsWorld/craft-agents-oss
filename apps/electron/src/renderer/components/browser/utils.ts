/**
 * 浏览器组件的共享工具函数。
 */

// 从 URL 中提取可读的主机名或文件名，用于标签标题兜底。
export function getHostname(url: string): string {
  try {
    if (url === 'about:blank' || !url) return 'New Tab'
    const parsed = new URL(url)

    // file:// 协议时显示本地文件名而不是路径。
    if (parsed.protocol === 'file:') {
      const decodedPath = decodeURIComponent(parsed.pathname || '')
      if (!decodedPath || decodedPath === '/' || decodedPath.endsWith('/')) return 'Local File'

      const normalizedPath = decodedPath.replace(/\/+$/, '')
      const fileName = normalizedPath.split('/').filter(Boolean).at(-1)
      return fileName || 'Local File'
    }

    // 去掉常见的 www. 前缀，让显示更简洁。
    const hostname = parsed.hostname.replace(/^www\./, '')
    if (hostname) return hostname

    return parsed.protocol.replace(/:$/, '') || url
  } catch {
    return url
  }
}

/**
 * 计算 CSS 颜色字符串的相对亮度（WCAG 亮度公式）。
 * 浏览器环境通过创建一个隐藏的探针元素把任意 CSS 颜色解析成 RGB，
 * 再套用线性变换和加权公式得到 0~1 之间的亮度值。
 * 结果被缓存以避免重复创建 DOM 元素。
 */
const themeLuminanceCache = new Map<string, number | null>()

export function getThemeLuminance(color: string): number | null {
  // SSR 或没有 document 时直接返回 null，避免在 Node 环境报错。
  if (typeof document === 'undefined' || !document.body) return null

  // 先查缓存，命中直接返回。
  const cached = themeLuminanceCache.get(color)
  if (cached !== undefined) return cached

  // 创建离屏 span，把 color 设到 style.color 上，让浏览器帮我们解析各种颜色格式。
  const probe = document.createElement('span')
  probe.style.color = color
  probe.style.position = 'absolute'
  probe.style.opacity = '0'
  probe.style.pointerEvents = 'none'
  probe.style.left = '-9999px'
  document.body.appendChild(probe)

  const computed = getComputedStyle(probe).color
  probe.remove()

  // 把类似 "rgb(255, 128, 0)" 的字符串拆出 R、G、B 三个通道。
  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!match) {
    themeLuminanceCache.set(color, null)
    return null
  }

  // 把 sRGB 通道值转换到线性颜色空间，这是 WCAG 亮度公式要求的步骤。
  const toLinear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }

  const r = toLinear(Number(match[1]))
  const g = toLinear(Number(match[2]))
  const b = toLinear(Number(match[3]))

  // WCAG 2.1 相对亮度公式：人眼对绿色最敏感，所以绿色权重最高。
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  themeLuminanceCache.set(color, luminance)
  return luminance
}
