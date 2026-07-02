import { useRef, useCallback } from 'react'

/**
 * useDynamicStack — 实时动态堆叠徽章（badge），保持每个徽章露出等宽条带。
 *
 * 返回一个 callback ref，绑定到 flex 容器后，通过 ResizeObserver 计算每个徽章的 marginLeft。
 * 分为两个阶段：
 *
 * 1. TRANSITION（间隙收缩）：所有间隙均匀缩小。
 *    容器变窄时，所有 gap 从设定的 gap 值等量减少到 0。
 *    适用于 V >= 最窄非末尾徽章宽度时，避免按徽章公式产生的不均匀正边距。
 *
 * 2. STACKING（等宽可见条带）：按徽章计算 marginLeft，使每个徽章恰好露出 V 像素。
 *    越宽的徽章需要越大的负边距。此阶段所有 marginLeft ≤ 0。
 *    适用于 V < 最窄非末尾徽章宽度时。
 *
 * 在临界点附近做短距离平滑过渡，避免视觉跳变。
 *
 * 关键设计：
 * - callback ref：在 mount 时立即挂接 observer，早于首次绘制
 * - 不使用 rAF：ResizeObserver 在 layout 与 paint 之间触发（同帧更新）
 * - 直接操作子元素 style（不用 CSS 变量，不触发 React re-render）
 * - MutationObserver：子元素增删时重新计算
 *
 * @param options.gap - 空间充足时徽章间距（默认 8）
 * @param options.minVisible - 每个徽章最小可见条带宽度（默认 20）
 * @param options.reservedStart - 仅在堆叠阶段生效的视觉预留宽度（上限为一个 gap），
 *   用于稳定渐变淡出行为（默认 0）
 */
export function useDynamicStack(options?: { gap?: number; minVisible?: number; reservedStart?: number }) {
  const { gap = 8, minVisible = 20, reservedStart = 0 } = options ?? {}
  const observerRef = useRef<ResizeObserver | null>(null)
  const mutationRef = useRef<MutationObserver | null>(null)

  // callback ref：在 React commit 阶段同步触发，mount/unmount 时执行
  const callbackRef = useCallback((el: HTMLDivElement | null) => {
    // 清理之前的 observer
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    if (mutationRef.current) {
      mutationRef.current.disconnect()
      mutationRef.current = null
    }

    if (!el) return

    const compute = () => {
      const children = el.children
      const childCount = children.length
      if (childCount === 0) return

      if (childCount === 1) {
        const child = children[0] as HTMLElement
        child.style.marginLeft = '0px'
        child.style.maskImage = 'none'
        child.style.webkitMaskImage = 'none'
        return
      }

      // 测量每个子元素的自然宽度（offsetWidth 不含 margin）
      const widths: number[] = []
      for (let i = 0; i < childCount; i++) {
        widths.push((children[i] as HTMLElement).offsetWidth)
      }

      const totalWidth = widths.reduce((sum, w) => sum + w, 0)
      const availableWidth = el.clientWidth

      // 阶段 0：空间足够，均匀 gap，无需堆叠
      // 使用实际测量宽度，避免视觉预留参数导致过早进入堆叠
      const totalWithGaps = totalWidth + (childCount - 1) * gap
      if (totalWithGaps <= availableWidth) {
        for (let i = 0; i < childCount; i++) {
          const child = children[i] as HTMLElement
          child.style.marginLeft = i === 0 ? '0px' : `${gap}px`
          // 无重叠时清除可能存在的遮罩
          child.style.maskImage = 'none'
          child.style.webkitMaskImage = 'none'
        }
        return
      }

      // 堆叠阶段可选的微小预留（上限为一个 gap）
      // 让渐变淡出更稳定，但不会强制提前重叠
      const stackingWidth = Math.max(0, availableWidth - Math.min(reservedStart, gap))

      // 等宽条带目标值 V
      const V = Math.max(minVisible, (stackingWidth - widths[childCount - 1]) / (childCount - 1))

      // 最窄的非末尾徽章宽度，即阶段切换临界点
      // 当 V 小于它时，所有按徽章计算的 marginLeft ≤ 0（无不均匀正 gap）
      const nonLastWidths = widths.slice(0, -1)
      const minNonLastWidth = Math.min(...nonLastWidths)

      // 均匀边距：把总缺口平均分配到所有间隙
      // 无论单个徽章多宽，视觉上间隙都是均匀的
      const uniformMargin = Math.min(gap, (stackingWidth - totalWidth) / (childCount - 1))

      if (V >= minNonLastWidth) {
        // 阶段 1：TRANSITION — V 大于某些徽章宽度
        // 按徽章公式会给窄徽章正边距（不均匀），改用均匀边距
        for (let i = 0; i < childCount; i++) {
          ;(children[i] as HTMLElement).style.marginLeft = i === 0 ? '0px' : `${uniformMargin}px`
        }
      } else {
        // 阶段 2：STACKING — V 小于所有非末尾徽章宽度
        // 按徽章计算的 marginLeft 都 ≤ 0，每个徽章露出等宽条带
        // 在临界点附近从均匀边距混合到按徽章边距，实现平滑过渡
        // t=0 在临界点（V = minNonLastWidth），t=1 在深度堆叠时
        const blendRange = minNonLastWidth * 0.5
        const t = Math.min(1, (minNonLastWidth - V) / blendRange)

        for (let i = 0; i < childCount; i++) {
          if (i === 0) {
            ;(children[i] as HTMLElement).style.marginLeft = '0px'
          } else {
            // 线性插值：uniform（均匀间隙）→ per-badge（等宽条带）
            const perBadge = V - widths[i - 1]
            const blended = uniformMargin * (1 - t) + perBadge * t
            ;(children[i] as HTMLElement).style.marginLeft = `${blended}px`
          }
        }
      }

      // 遮罩 + z-index 遍历：给每个非末尾徽章右侧边缘做淡出，
      // 并提升后面徽章的层级，使其不透明背景盖住前面徽章被裁剪后的阴影区域
      for (let i = 0; i < childCount; i++) {
        const child = children[i] as HTMLElement
        // 后面的徽章 paint 在上层，盖住前面徽章重叠区的裁剪阴影
        child.style.position = 'relative'
        child.style.zIndex = `${i}`
        if (i === childCount - 1) {
          // 最后一个徽章在最上层，完全可见，不需要遮罩
          child.style.maskImage = 'none'
          child.style.webkitMaskImage = 'none'
        } else {
          // 当与下一个徽章的间隙小于 4px 时开始渐变淡出，
          // 在 36px 范围内把透明度从 0 提升到最大 66%
          const nextMargin = parseFloat((children[i + 1] as HTMLElement).style.marginLeft || '0')
          const fadeStart = 4 // 间隙小于此值时开始淡出
          if (nextMargin < fadeStart) {
            const proximity = fadeStart - nextMargin // 0 在阈值，徽章越靠近/重叠越大
            const fadeZone = 36
            const t = Math.min(1, proximity / 36)
            const endAlpha = 1 - t * 0.66 // 最大淡出到 66% 透明
            // 渐变终点放在重叠区右侧，向右偏移 24px
            // gradientEnd = 淡出右边界；gradientStart = 左边界（距离徽章左侧至少 12px）
            const actualOverlap = Math.max(0, -nextMargin)
            const gradientEnd = Math.max(0, actualOverlap - 24)
            const gradientStart = Math.min(widths[i] - 12, gradientEnd + fadeZone)
            const mask = `linear-gradient(to right, black calc(100% - ${gradientStart}px), rgba(0,0,0,${endAlpha}) calc(100% - ${gradientEnd}px), rgba(0,0,0,${endAlpha}) 100%)`
            child.style.maskImage = mask
            child.style.webkitMaskImage = mask
          } else {
            // 空间足够，清除遮罩
            child.style.maskImage = 'none'
            child.style.webkitMaskImage = 'none'
          }
        }
      }
    }

    // mount 后立即计算（首次绘制前）
    compute()

    // ResizeObserver 在 layout 与 paint 之间触发，零帧延迟
    observerRef.current = new ResizeObserver(compute)
    observerRef.current.observe(el)

    // MutationObserver：徽章增删时重新计算
    mutationRef.current = new MutationObserver(compute)
    mutationRef.current.observe(el, { childList: true })
  }, [gap, minVisible, reservedStart])

  return callbackRef
}
