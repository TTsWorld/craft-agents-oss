/**
 * responsive.ts — WebUI 的移动端检测 hook。
 *
 * 大部分布局响应式已由共享 renderer 组件里的容器查询（container queries）
 * 和 isAutoCompact 处理。本模块只提供视口级别的移动端判断，
 * 用于触摸事件、虚拟键盘、安全区等少数场景。
 */

import { useState, useEffect } from 'react'

// 判定移动端的宽度阈值
const MOBILE_MEDIA_QUERY = '(max-width: 768px)'

/**
 * 返回当前视口是否为移动端宽度。
 *
 * 尽量少用 —— 布局优先使用容器查询（@container）。
 * 这个 hook 只处理触摸、虚拟键盘等视口级别问题。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    // typeof window !== 'undefined' 保证 SSR/服务端渲染时不会访问不存在对象
    return typeof window !== 'undefined'
      ? window.matchMedia(MOBILE_MEDIA_QUERY).matches
      : false
  })

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const onChange = () => setIsMobile(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
