/**
 * PlatformContext - 平台特定操作的抽象层
 *
 * 该上下文使 UI 组件能在 Electron 与 Web 环境下同时工作。
 * Electron 提供真实实现，Web 查看器提供空操作或替代实现。
 *
 * 模式：通过 context 实现依赖注入
 * - 组件通过 usePlatform() 获取操作方法
 * - 操作方法均为可选 - 组件在调用前需检查其是否存在
 * - Web 查看器可提供内联弹窗来替代新窗口
 */

import { createContext, useContext, type ReactNode } from 'react'

/**
 * 组件可能需要的平台特定操作
 * 所有操作均为可选 - 各平台只实现其支持的能力
 */
export interface PlatformActions {
  /**
   * 在默认应用程序中打开文件（Electron：shell.openPath）
   * Web：可内联展示文件内容或提供下载
   */
  onOpenFile?: (path: string) => void

  /**
   * 直接在系统编辑器中打开文件，绕过链接拦截器。
   * 供浮层头部徽章使用 —— 当已在查看某文件时，"打开"应启动
   * 外部编辑器，而非再次触发应用内预览。
   */
  onOpenFileExternal?: (path: string) => void

  /**
   * 在默认浏览器中打开 URL（Electron：shell.openExternal）
   * Web：window.open 或导航跳转
   */
  onOpenUrl?: (url: string) => void

  /**
   * 在新窗口中打开代码预览（Electron：打开 Monaco 窗口）
   * Web：可显示带语法高亮的内联弹窗
   */
  onOpenCodePreview?: (sessionId: string, toolUseId: string) => void

  /**
   * 打开终端输出预览（Electron：打开终端窗口）
   * Web：可显示等宽输出的内联弹窗
   */
  onOpenTerminalPreview?: (sessionId: string, toolUseId: string) => void

  /**
   * 打开 Markdown 预览窗口
   * Web：可显示全屏弹窗
   */
  onOpenMarkdownPreview?: (content: string) => void

  /**
   * 打开多文件 diff 视图
   * Web：可显示内联 diff 查看器
   */
  onOpenMultiFileDiff?: (sessionId: string, turnId: string) => void

  /**
   * 将文本复制到剪贴板
   * 两种环境下均通过 navigator.clipboard 实现
   */
  onCopyToClipboard?: (text: string) => Promise<void>

  /**
   * 在新窗口/弹窗中打开 turn 详情
   */
  onOpenTurnDetails?: (sessionId: string, turnId: string) => void

  /**
   * 在新窗口/弹窗中打开 activity 详情
   */
  onOpenActivityDetails?: (sessionId: string, activityId: string) => void

  /**
   * 以 UTF-8 字符串形式读取文件内容（Electron：通过 IPC 调用 fs.readFile）
   * 供 datatable/spreadsheet/html-preview 块加载文件内容使用
   */
  onReadFile?: (path: string) => Promise<string>

  /**
   * 以 data URL 形式读取文件（Electron：通过 IPC 调用 fs.readFile + base64 编码）
   * 供 image-preview 块和图片浮层使用
   */
  onReadFileDataUrl?: (path: string) => Promise<string>

  /**
   * 以二进制 Uint8Array 形式读取文件（Electron：通过 IPC 调用 fs.readFile）
   * 供需要原始二进制数据的 PDF 预览块使用
   */
  onReadFileBinary?: (path: string) => Promise<Uint8Array>

  /**
   * 在系统文件管理器中显示文件（Electron：shell.showItemInFolder）
   * Web：不可用（为 undefined 时隐藏对应菜单项）
   */
  onRevealInFinder?: (path: string) => void

  /**
   * 平台特定的文件管理器名称，用于展示文案。
   * macOS → "Finder"，Windows → "Explorer"，Linux → "File Manager"
   * 未提供时默认为 "Finder"。
   */
  fileManagerName?: string

  /**
   * 显示/隐藏 macOS 红绿灯按钮（关闭/最小化/最大化）。
   * 用于在全屏浮层打开时隐藏它们，防止误触。
   * 在非 macOS 平台或 Web 查看器中为空操作。
   */
  onSetTrafficLightsVisible?: (visible: boolean) => void
}

const PlatformContext = createContext<PlatformActions>({})

export interface PlatformProviderProps {
  children: ReactNode
  actions?: PlatformActions
}

/**
 * PlatformProvider - 以平台特定操作包装组件
 *
 * Electron 中的用法：
 * ```tsx
 * <PlatformProvider actions={{
 *   onOpenFile: (path) => window.electronAPI.openFile(path),
 *   onOpenUrl: (url) => window.electronAPI.openUrl(url),
 *   onCopyToClipboard: (text) => navigator.clipboard.writeText(text),
 * }}>
 *   <SessionViewer session={session} />
 * </PlatformProvider>
 * ```
 *
 * Web 查看器中的用法：
 * ```tsx
 * <PlatformProvider actions={{
 *   onOpenUrl: (url) => window.open(url, '_blank'),
 *   onCopyToClipboard: (text) => navigator.clipboard.writeText(text),
 *   // 未提供 onOpenFile - 点击无反应或内联展示
 * }}>
 *   <SessionViewer session={session} mode="readonly" />
 * </PlatformProvider>
 * ```
 */
export function PlatformProvider({ children, actions = {} }: PlatformProviderProps) {
  return (
    <PlatformContext.Provider value={actions}>
      {children}
    </PlatformContext.Provider>
  )
}

/**
 * usePlatform - 在组件中访问平台特定操作
 *
 * 组件在调用前应检查操作是否存在：
 * ```tsx
 * const { onOpenFile } = usePlatform()
 * const handleClick = () => onOpenFile?.(filePath)
 * ```
 *
 * 或提供降级行为：
 * ```tsx
 * const { onOpenCodePreview } = usePlatform()
 * const handleClick = () => {
 *   if (onOpenCodePreview) {
 *     onOpenCodePreview(sessionId, toolUseId)
 *   } else {
 *     setShowInlineModal(true)
 *   }
 * }
 * ```
 */
export function usePlatform(): PlatformActions {
  return useContext(PlatformContext)
}

export default PlatformContext
