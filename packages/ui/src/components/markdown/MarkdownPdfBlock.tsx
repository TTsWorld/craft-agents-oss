/**
 * MarkdownPdfBlock - 将 ```pdf-preview 代码块渲染为内联 PDF 预览。
 *
 * 通过 `src` 或 `items` 字段从文件加载 PDF,并使用 react-pdf 渲染首页。
 * 支持多个 item,带 tab 栏用于切换。
 *
 * 期望的 JSON 结构:
 * 单个 item:
 * {
 *   "src": "/absolute/path/to/file.pdf",
 *   "title": "Optional title"
 * }
 *
 * 多个 item:
 * {
 *   "title": "Quarterly Reports",
 *   "items": [
 *     { "src": "/path/to/q1.pdf", "label": "Q1 Report" },
 *     { "src": "/path/to/q2.pdf", "label": "Q2 Report" }
 *   ]
 * }
 *
 * 同一时间只挂载一个 Document。内容区使用固定高度容器,避免切换 item 时布局抖动。
 *
 * 内联:在固定 400px 容器中展示首页,带底部渐隐 + 展开按钮。
 * 全屏:打开 PDFPreviewOverlay,提供逐页导航。
 */

import * as React from 'react'
import { FileText, Maximize2 } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { PDFPreviewOverlay } from '../overlay/PDFPreviewOverlay'
import { ItemNavigator } from '../overlay/ItemNavigator'
import { usePlatform } from '../../context/PlatformContext'
import { useTranslation } from 'react-i18next'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// 使用 Vite 的 ?url 导入配置 pdf.js worker,以便跨平台 dev/prod 兼容
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

// ── 类型 ────────────────────────────────────────────────────────────────────

interface PreviewItem {
  src: string
  label?: string
}

interface PdfPreviewSpec {
  src?: string
  title?: string
  items?: PreviewItem[]
}

// ── 错误边界 ───────────────────────────────────────────────────────────────

class PdfBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownPdfBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── 主组件 ───────────────────────────────────────────────────────────────────

export interface MarkdownPdfBlockProps {
  code: string
  className?: string
  onCreateRegionAnnotation?: (region: { page?: number; x: number; y: number; w: number; h: number; unit: 'pixel' | 'percent' }) => void
}

export function MarkdownPdfBlock({ code, className, onCreateRegionAnnotation: _onCreateRegionAnnotation }: MarkdownPdfBlockProps) {
  const { t } = useTranslation()
  const { onReadFileBinary } = usePlatform()

  // 解析 JSON spec —— 支持单个 src 或 items 数组
  const spec = React.useMemo<PdfPreviewSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.items && Array.isArray(raw.items) && raw.items.length > 0) {
        return raw as PdfPreviewSpec
      }
      if (raw.src && typeof raw.src === 'string') {
        return raw as PdfPreviewSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  // 归一化为 items 数组(向后兼容)
  const items = React.useMemo<PreviewItem[]>(() => {
    if (!spec) return []
    if (spec.items && spec.items.length > 0) return spec.items
    if (spec.src) return [{ src: spec.src }]
    return []
  }, [spec])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  // 内容缓存:src 路径 → 已加载的 Uint8Array(主副本,不直接传给 react-pdf)
  const [contentCache, setContentCache] = React.useState<Record<string, Uint8Array>>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const activeItem = items[activeIndex]
  const activePdfData = activeItem ? contentCache[activeItem.src] : undefined

  // 当 active item 变化时加载其内容
  React.useEffect(() => {
    if (!activeItem?.src || !onReadFileBinary) return
    if (contentCache[activeItem.src]) {
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    onReadFileBinary(activeItem.src)
      .then((data) => {
        // 存一份副本 —— react-pdf 会把 ArrayBuffer 转移给 worker,使原 buffer 被分离(detach)
        setContentCache((prev) => ({ ...prev, [activeItem.src]: new Uint8Array(data) }))
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to read PDF file')
      })
      .finally(() => setLoading(false))
  }, [activeItem?.src, onReadFileBinary, contentCache])

  // 每个 item 对应的稳定 file 对象(ref 保证 Document 在重渲染时不会重新挂载)。
  // 每个 Document 拿到自己的 Uint8Array 副本,因为 react-pdf 会转移 ArrayBuffer。
  const fileObjsRef = React.useRef<Record<string, { data: Uint8Array }>>({})
  for (const [src, data] of Object.entries(contentCache)) {
    if (!fileObjsRef.current[src]) {
      fileObjsRef.current[src] = { data: new Uint8Array(data) }
    }
  }

  const activeFileObj = activeItem ? fileObjsRef.current[activeItem.src] : undefined

  // 全屏浮层:总是提供一份新副本(浮层的 Document 也会转移它)
  const loadPdfData = React.useCallback(async (path: string) => {
    if (contentCache[path]) return new Uint8Array(contentCache[path])
    if (!onReadFileBinary) throw new Error('Cannot load PDF')
    return onReadFileBinary(path)
  }, [contentCache, onReadFileBinary])

  const hasMultiple = items.length > 1

  // 无效 spec → 回退到代码块
  if (!spec || items.length === 0) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  return (
    <PdfBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* 标题栏 */}
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1">
            {spec.title || t('preview.pdfPreview')}
          </span>
          <div className="flex items-center gap-1">
            <ItemNavigator items={items} activeIndex={activeIndex} onSelect={setActiveIndex} />
            <button
              onClick={() => setIsFullscreen(true)}
              className={cn(
                "p-1 rounded-[6px] transition-all select-none",
                "bg-background shadow-minimal",
                "text-muted-foreground/50 hover:text-foreground",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
                hasMultiple ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              title={t('common.viewFullscreen')}
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 内容区:固定高度,避免切换 item 时布局抖动 */}
        <div className="relative h-[400px] overflow-hidden">
          {/* 当前 Document(同一时间只挂载一个) */}
          {activeFileObj && (
            <div className="flex items-start justify-center bg-white p-4">
              <Document
                file={activeFileObj}
                loading={<div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.rendering')}</div>}
                error={<div className="py-6 text-center text-destructive/70 text-[13px]">{t('preview.failedToRenderPdf')}</div>}
              >
                <Page
                  pageNumber={1}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  width={500}
                />
              </Document>
            </div>
          )}

          {/* 未缓存 active item 的加载态 */}
          {!activePdfData && loading && (
            <div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.loading')}</div>
          )}

          {/* 未缓存 active item 的错误态 */}
          {!activePdfData && !loading && error && (
            <div className="py-6 text-center text-destructive/70 text-[13px]">{error}</div>
          )}

          {/* 底部渐隐渐变 */}
          {activePdfData && (
            <div
              className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
              style={{
                background: 'linear-gradient(to bottom, transparent, var(--muted))',
                zIndex: 'var(--z-local, 10)',
              }}
            />
          )}
        </div>
      </div>

      {/* 全屏浮层 —— 传入 items 以支持多 item 导航 */}
      <PDFPreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        filePath={activeItem!.src}
        items={items}
        initialIndex={activeIndex}
        loadPdfData={loadPdfData}
      />
    </PdfBlockErrorBoundary>
  )
}

