/**
 * shiki 组件模块入口
 *
 * 统一导出本目录下的三个 Shiki 相关组件：
 * - ShikiCodeViewer：只读代码查看器
 * - ShikiCodeEditor：可编辑代码/Markdown 编辑器
 * - ShikiDiffViewer：diff 对比查看器
 */

export { ShikiCodeViewer, type ShikiCodeViewerProps } from './ShikiCodeViewer'
export { ShikiCodeEditor, type ShikiCodeEditorProps } from './ShikiCodeEditor'
export { ShikiDiffViewer, type ShikiDiffViewerProps } from './ShikiDiffViewer'
