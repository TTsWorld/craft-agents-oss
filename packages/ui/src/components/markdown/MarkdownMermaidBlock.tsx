import * as React from 'react'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { Maximize2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { MermaidPreviewOverlay } from '../overlay/MermaidPreviewOverlay'
import { normalizeMermaidSource } from './mermaid-source'
import { useScrollFade } from './useScrollFade'
import { useTranslation } from 'react-i18next'

// ============================================================================
// MarkdownMermaidBlock —— 将 mermaid 代码围栏渲染为 SVG 图。
//
// 使用 beautiful-mermaid 解析流程图文本并生成 SVG 字符串。
// 渲染失败时(语法错误等)回退到普通代码块。
//
// 主题:颜色以 CSS 变量引用(var(--background)、var(--foreground) 等)传入,
// 使 SVG 通过 CSS 级联继承应用的主题系统。主题切换(亮/暗、预设变更)会
// 自动生效,无需重新渲染 —— 浏览器会解析这些变量。
//
// 宽图:水平方向(graph LR)且节点众多的图,在适配容器宽度时可能小到无法阅读。
// 为此我们强制一个最小渲染高度(MIN_READABLE_HEIGHT)。若按自然比例渲染的高度
// 低于该阈值,则放大并允许横向滚动。CSS mask 渐变会在边缘做淡出处理以提示可滚动。
// ============================================================================

// 图表的最小渲染高度。宽水平图至少放大到该高度以保持文字可读,并允许横向滚动。
const MIN_READABLE_HEIGHT = 280

// 滚动指示器的淡出区大小(px)
const FADE_SIZE = 32

// 较小的溢出阈值 —— 若图表溢出量小于该值,则缩放以适配而非滚动
const SMALL_OVERFLOW_THRESHOLD = 200

/** 从 SVG 字符串根元素的属性中解析 width/height。 */
function parseSvgDimensions(svgString: string): { width: number; height: number } | null {
  const widthMatch = svgString.match(/width="(\d+(?:\.\d+)?)"/)
  const heightMatch = svgString.match(/height="(\d+(?:\.\d+)?)"/)
  if (!widthMatch?.[1] || !heightMatch?.[1]) return null
  return { width: parseFloat(widthMatch[1]), height: parseFloat(heightMatch[1]) }
}

interface MarkdownMermaidBlockProps {
  code: string
  className?: string
  /** 是否显示内联展开按钮。默认 true。
   *  当 mermaid block 是消息中的首个 block 时设为 false ——
   *  此时 TurnCard 自己的全屏按钮已占据同一位置。 */
  showExpandButton?: boolean
  /** 点击/轻触内联图是否打开全屏。
   *  默认启用,以便与 image block 在聊天场景下保持一致;编辑器 node-view 可禁用。 */
  tapToOpen?: boolean
  /** 可选的最小 block 高度,在响应式尺寸稳定前预留空间。 */
  minHeight?: number
}

export function MarkdownMermaidBlock({ code, className, showExpandButton = true, tapToOpen = true, minHeight }: MarkdownMermaidBlockProps) {
  const { t } = useTranslation()
  // 同步渲染 —— 避免 CodeBlock 与 SVG 之间出现闪烁。
  // 颜色使用 CSS 变量引用,使 SVG 通过 CSS 级联继承应用主题。
  // 主题切换会自动生效,无需重新渲染。
  const { svg, error } = React.useMemo(() => {
    try {
      return {
        svg: renderMermaidSVG(normalizeMermaidSource(code), {
          bg: 'var(--background)',
          fg: 'var(--foreground)',
          accent: 'var(--accent)',
          line: 'var(--foreground-30)',
          muted: 'var(--muted-foreground)',
          surface: 'var(--foreground-3)',
          border: 'var(--foreground-20)',
          transparent: true,
          interactive: true,
        }),
        error: null,
      }
    } catch (err) {
      return { svg: null, error: err instanceof Error ? err : new Error(String(err)) }
    }
  }, [code])

  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const { scrollRef, maskImage } = useScrollFade(FADE_SIZE)

  // 稳定的容器宽度 —— 通过 useLayoutEffect 在浏览器绘制前测量,
  // 以避免首帧 scrollRef.current 为 null 导致的闪烁。
  const [containerWidth, setContainerWidth] = React.useState(0)

  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) setContainerWidth(el.clientWidth)
  }, [svg])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 计算宽图的缩放尺寸。
  // 若按容器宽度自然缩放后的高度低于 MIN_READABLE_HEIGHT,则放大到该高度 ——
  // 但不超过 100%(自然尺寸)。避免小图被过度放大导致模糊。
  const getScaledDimensions = React.useCallback(() => {
    if (!svg) return null
    if (!containerWidth) return null

    const dims = parseSvgDimensions(svg)
    if (!dims) return null

    // 计算适配容器宽度时的高度
    const fitToContainerScale = containerWidth / dims.width
    const projectedHeight = dims.height * fitToContainerScale

    // 若图高度在自然尺寸下没问题,检查宽度是否溢出
    if (projectedHeight >= MIN_READABLE_HEIGHT) {
      const overflow = dims.width - containerWidth

      // 溢出较小:缩放适配而非滚动
      if (overflow > 0 && overflow < SMALL_OVERFLOW_THRESHOLD) {
        const scaledHeight = dims.height * fitToContainerScale
        return { scale: fitToContainerScale, width: containerWidth, height: scaledHeight, needsScroll: false }
      }

      // 溢出较大:保持自然尺寸并启用滚动
      const needsScroll = overflow > 0
      return {
        scale: 1,
        width: needsScroll ? dims.width : undefined,
        height: needsScroll ? dims.height : undefined,
        needsScroll,
      }
    }

    // 按容器宽度图会太小。
    // 放大到 MIN_READABLE_HEIGHT,但上限为 100%(自然尺寸)。
    const desiredScale = MIN_READABLE_HEIGHT / dims.height
    const scale = Math.min(desiredScale, 1.0)

    const scaledWidth = dims.width * scale
    const scaledHeight = dims.height * scale

    // 若缩放后内容仍宽于容器(超过阈值)则启用滚动
    const scaledOverflow = scaledWidth - containerWidth
    if (scaledOverflow > 0 && scaledOverflow < SMALL_OVERFLOW_THRESHOLD) {
      // 溢出较小:缩放以适配容器
      const fitScale = containerWidth / dims.width
      const fitHeight = dims.height * fitScale
      return { scale: fitScale, width: containerWidth, height: fitHeight, needsScroll: false }
    }

    return {
      scale,
      width: scaledWidth,
      height: scaledHeight,
      needsScroll: scaledOverflow > 0,
    }
  }, [svg, containerWidth])

  // 出错时回退到展示 mermaid 源码的普通代码块
  if (error) {
    return <CodeBlock code={code} language="mermaid" mode="full" className={className} />
  }

  // 兜底:若 SVG 为 null(理论上应已被上面的 error 捕获,保险起见)
  if (!svg) {
    return <CodeBlock code={code} language="mermaid" mode="full" className={className} />
  }

  const scaledDims = getScaledDimensions()
  const minHeightStyle = minHeight != null ? { minHeight: `${minHeight}px` } : undefined

  // 缩放模式:当提供了尺寸或 scale !== 1 时
  // 与 needsScroll 相互独立 —— 可能缩放适配但不滚动
  const needsScaling = scaledDims && (scaledDims.width != null || scaledDims.scale !== 1)

  return (
    <>
      {/* 带 group class 的包裹层,使展开按钮在 hover 时显示 */}
      <div className={cn('relative group', className)} style={minHeightStyle}>
        {/* 展开按钮 —— 与代码块的展开按钮样式一致(TurnCard 模式)。
            当 showExpandButton 为 false 时隐藏(消息首个 block,此时 TurnCard
            自己的全屏按钮占据了同一个右上角位置)。 */}
        {showExpandButton && (
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              "absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10 select-none",
              "opacity-0 group-hover:opacity-100",
              "bg-background shadow-minimal",
              "text-muted-foreground/50 hover:text-foreground",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
            )}
            title={t('common.viewFullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}

        {/* 带淡出 mask 的滚动容器,用于提示溢出。
            当内容可滚动时,CSS mask 渐变会在边缘做淡出处理。 */}
        <div
          ref={scrollRef}
          style={{
            overflowX: 'auto',
            overflowY: 'hidden',
            maskImage,
            WebkitMaskImage: maskImage,
            ...minHeightStyle,
          }}
        >
          {/* 尺寸包裹层 —— 缩放或滚动时使用显式尺寸。
              缩放/滚动内容用 block 显示,自然适配时用 flex 居中。 */}
          <div
            style={{
              width: needsScaling && scaledDims?.width ? `${scaledDims.width}px` : undefined,
              height: needsScaling && scaledDims?.height ? `${scaledDims.height}px` : undefined,
              display: needsScaling ? 'block' : 'flex',
              justifyContent: needsScaling ? undefined : 'center',
              margin: needsScaling && !scaledDims?.needsScroll ? '0 auto' : undefined,
              cursor: tapToOpen ? 'pointer' : undefined,
            }}
            onClick={tapToOpen ? () => setIsFullscreen(true) : undefined}
            role={tapToOpen ? 'button' : undefined}
            aria-label={tapToOpen ? 'Open Mermaid diagram fullscreen' : undefined}
            tabIndex={tapToOpen ? 0 : undefined}
            onKeyDown={tapToOpen ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setIsFullscreen(true)
              }
            } : undefined}
          >
            {/* SVG 容器 —— CSS transform 对 SVG 做视觉缩放。
                transform-origin: top left 确保缩放向右下方扩展。 */}
            <div
              dangerouslySetInnerHTML={{ __html: svg }}
              style={{
                transformOrigin: 'top left',
                transform: scaledDims && scaledDims.scale !== 1 ? `scale(${scaledDims.scale})` : undefined,
              }}
            />
          </div>
        </div>
      </div>

      {/* 带缩放/平移的全屏浮层 */}
      <MermaidPreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        svg={svg}
        code={code}
      />
    </>
  )
}
