// Browser 实时效果（Live FX）常量与工具函数
// 定义跨平台圆角、浏览器浮层边框样式，以及把 CSS 变量解析为具体颜色值的辅助函数。

// 支持的操作系统平台，对应 Electron 的 process.platform；'other' 用于兜底
export type BrowserLiveFxPlatform = 'darwin' | 'win32' | 'linux' | 'other'

// 浏览器浮层四个角的圆角半径
// 在 TS 里用 interface 描述对象形状，类似 Go 里的 struct，但只约束字段类型，不包含方法
export interface BrowserLiveFxCornerRadii {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
}

// 浏览器浮层默认边框样式
// 'as const' 让 TS 把每个字段推断为字面量类型（类似 Go 的 const），而不是宽泛的 string
export const BROWSER_LIVE_FX_BORDER = {
  width: '1.5px',
  style: 'solid',
  color: 'var(--accent)',
  boxShadow:
    'inset 0 0 0 1px color-mix(in oklab, var(--accent) 45%, transparent), inset 0 0 20px color-mix(in oklab, var(--accent) 28%, transparent)',
} as const

/**
 * 返回使用具体强调色（accent color）的边框颜色与 boxShadow。
 *
 * 使用场景：向外部 DOM（例如通过 CDP 注入的网页 overlay）写入样式时，
 * `var(--accent)` 会按目标网页自己的样式表解析，因此需要先把颜色变量换成实际值。
 */
export function resolveBrowserLiveFxBorder(accentColor: string): { color: string; boxShadow: string } {
  return {
    color: accentColor,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accentColor} 45%, transparent), inset 0 0 20px color-mix(in oklab, ${accentColor} 28%, transparent)`,
  }
}

// 根据平台返回底部圆角：macOS 16px、Windows 8px、其他平台 6px
export function getBrowserLiveFxCornerRadii(platform: BrowserLiveFxPlatform): BrowserLiveFxCornerRadii {
  const bottomRadius = platform === 'darwin' ? 16 : platform === 'win32' ? 8 : 6

  return {
    topLeft: '0px',
    topRight: '0px',
    bottomLeft: `${bottomRadius}px`,
    bottomRight: `${bottomRadius}px`,
  }
}
