/**
 * useLinkInterceptor - 集中拦截文件/URL 打开请求的 hook。
 *
 * 替代 App.tsx 中旧的 handleOpenFile/handleOpenUrl（它们总是外部打开）。
 * 现在根据文件类型决定：是显示应用内预览浮层，还是回退到用默认外部程序打开。
 *
 * 架构：
 *   Markdown 点击 → PlatformContext → App.tsx → useLinkInterceptor
 *     ├── 可预览？→ 设置 previewState（在 App.tsx 中渲染浮层）
 *     └── 不可预览？→ electronAPI.openFile（外部打开）
 *
 * 用 ref 保存 options，使返回的回调引用稳定，
 * 避免消费者（AppShellContext、PlatformProvider）不必要的重渲染。
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { classifyFile, type FilePreviewType } from '@craft-agent/ui'
import { getLanguageFromPath } from '@/lib/file-utils'

// ── 预览状态类型 ─────────────────────────────────────────────────────────────
// 每个变体携带渲染对应浮层所需的数据。
// 文本类文件（code、markdown、json、text）初始 content 为 null，
// 文件读取完成后再填充。

interface ImagePreview {
  type: 'image'
  filePath: string
}

interface PDFPreview {
  type: 'pdf'
  filePath: string
}

interface CodePreview {
  type: 'code'
  filePath: string
  content: string | null
  language: string
  error?: string
}

interface MarkdownPreview {
  type: 'markdown'
  filePath: string
  content: string | null
  error?: string
}

interface JSONPreview {
  type: 'json'
  filePath: string
  content: string | null
  error?: string
}

interface TextPreview {
  type: 'text'
  filePath: string
  content: string | null
  error?: string
}

export type FilePreviewState =
  | ImagePreview
  | PDFPreview
  | CodePreview
  | MarkdownPreview
  | JSONPreview
  | TextPreview

// ── Hook 选项 ───────────────────────────────────────────────────────────────
// 由 App.tsx 注入回调，使 hook 不直接依赖 window.electronAPI。

interface LinkInterceptorOptions {
  /** 用默认外部程序打开文件（例如 VS Code） */
  openFileExternal: (path: string) => Promise<void>
  /** 用默认浏览器打开 URL */
  openUrl: (url: string) => Promise<void>
  /** 在系统文件管理器中显示文件 */
  showInFolder: (path: string) => Promise<void>
  /** 以 UTF-8 文本读取文件（用于 code、markdown、json、text 预览） */
  readFile: (path: string) => Promise<string>
  /** 以 data URL 读取文件（用于图片预览） */
  readFileDataUrl: (path: string) => Promise<string>
  /** 以二进制（Uint8Array）读取文件，供 react-pdf 做 PDF 预览 */
  readFileBinary: (path: string) => Promise<Uint8Array>
}

// ── Hook 返回类型 ───────────────────────────────────────────────────────────

interface LinkInterceptorResult {
  /** 替代 App.tsx handleOpenFile —— 分类并路由 */
  handleOpenFile: (path: string) => void
  /** 替代 App.tsx handleOpenUrl —— 总是外部打开 */
  handleOpenUrl: (url: string) => void
  /** 绕过分类/预览，直接用外部程序打开文件 */
  openFileExternal: (path: string) => void
  /** 当前预览状态，驱动 App.tsx 渲染哪个浮层 */
  previewState: FilePreviewState | null
  /** 关闭预览浮层 */
  closePreview: () => void
  /** 用外部程序打开当前正在预览的文件 */
  openCurrentExternal: () => void
  /** 在系统文件管理器中显示当前预览文件 */
  revealCurrentInFinder: () => void
  /** 以 data URL 读取文件 —— 传给图片浮层作为加载器 */
  readFileDataUrl: (path: string) => Promise<string>
  /** 以二进制读取文件 —— 传给 PDF 浮层用于 react-pdf */
  readFileBinary: (path: string) => Promise<Uint8Array>
}

// ── Hook 实现 ───────────────────────────────────────────────────────────────

export function useLinkInterceptor(options: LinkInterceptorOptions): LinkInterceptorResult {
  const [previewState, setPreviewState] = useState<FilePreviewState | null>(null)

  // 用 ref 保存 options，使回调引用保持稳定。
  // 否则每次渲染都会创建新的 options 对象 → 新回调 →
  // AppShellContext 和 PlatformProvider 消费者级联重渲染。
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options }, [options])

  // 同样把 previewState 也放到 ref 里，
  // 这样 openCurrentExternal/revealCurrentInFinder 不需要把 previewState 放进依赖数组。
  const previewStateRef = useRef(previewState)
  useEffect(() => { previewStateRef.current = previewState }, [previewState])

  /**
   * 文件链接点击的主入口。
   * 按扩展名分类，然后要么打开预览浮层，要么回退到外部打开。
   *
   * 文本类文件（code、markdown、json、text）先读取内容再展示浮层 ——
   * 本地文件系统读取几乎是瞬时的，不需要 loading 状态。
   * 这样可避免浮层组件遇到 null content 的问题
   *（例如 @uiw/react-json-view 在 null 值上会崩溃）。
   */
  const handleOpenFile = useCallback(async (path: string) => {
    const classification = classifyFile(path)

    if (!classification.canPreview || !classification.type) {
      // 没有预览能力，用默认外部程序打开
      optionsRef.current.openFileExternal(path)
      return
    }

    const type = classification.type

    // 图片/PDF：立即设置状态，浮层内部自己处理异步加载
    if (type === 'image' || type === 'pdf') {
      setPreviewState({ type, filePath: path })
      return
    }

    // 文本类文件：先读取内容，再展示已准备好内容的浮层
    try {
      const content = await optionsRef.current.readFile(path)
      const state = buildInitialTextState(type, path)
      setPreviewState({ ...state, content } as FilePreviewState)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to read file'
      const state = buildInitialTextState(type, path)
      setPreviewState({ ...state, content: '', error: errorMsg } as FilePreviewState)
    }
  }, []) // 稳定：依赖 optionsRef

  /**
   * 绕过分类/预览，直接用外部程序打开文件。
   * 浮层顶部徽章的“打开”按钮使用它：已经在预览文件时，点击应启动编辑器。
   */
  const openFileExternal = useCallback((path: string) => {
    optionsRef.current.openFileExternal(path)
  }, []) // 稳定：依赖 optionsRef

  /** URL 总是外部打开 —— 不在应用内嵌浏览器，出于安全考虑 */
  const handleOpenUrl = useCallback((url: string) => {
    optionsRef.current.openUrl(url)
  }, []) // 稳定：依赖 optionsRef

  const closePreview = useCallback(() => {
    setPreviewState(null)
  }, [])

  /** 从浮层顶部用外部程序打开当前预览文件 */
  const openCurrentExternal = useCallback(() => {
    const state = previewStateRef.current
    if (state) {
      optionsRef.current.openFileExternal(state.filePath)
    }
  }, []) // 稳定：依赖 refs

  /** 从浮层顶部在系统文件管理器中显示当前预览文件 */
  const revealCurrentInFinder = useCallback(() => {
    const state = previewStateRef.current
    if (state) {
      optionsRef.current.showInFolder(state.filePath)
    }
  }, []) // 稳定：依赖 refs

  /** 稳定的 readFileDataUrl 引用，供图片浮层组件使用 */
  const readFileDataUrl = useCallback((path: string) => {
    return optionsRef.current.readFileDataUrl(path)
  }, []) // 稳定：依赖 optionsRef

  /** 稳定的 readFileBinary 引用，供 PDF 浮层使用 */
  const readFileBinary = useCallback((path: string) => {
    return optionsRef.current.readFileBinary(path)
  }, []) // 稳定：依赖 optionsRef

  return {
    handleOpenFile,
    handleOpenUrl,
    openFileExternal,
    previewState,
    closePreview,
    openCurrentExternal,
    revealCurrentInFinder,
    readFileDataUrl,
    readFileBinary,
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

/**
 * 为文本类文件类型构建初始预览状态。
 * content 初始为 null（加载中），异步读取后再填充。
 */
function buildInitialTextState(type: FilePreviewType, path: string): FilePreviewState {
  switch (type) {
    case 'code':
      return { type: 'code', filePath: path, content: null, language: getLanguageFromPath(path) }
    case 'markdown':
      return { type: 'markdown', filePath: path, content: null }
    case 'json':
      return { type: 'json', filePath: path, content: null }
    case 'text':
      return { type: 'text', filePath: path, content: null }
    default:
      // 正常不会走到这里 —— image/pdf 在此之前已处理
      return { type: 'text', filePath: path, content: null }
  }
}
