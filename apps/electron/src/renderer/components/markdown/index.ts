/**
 * markdown 模块入口
 *
 * 本目录存放 Electron 渲染进程（renderer）中使用的 Markdown 相关组件。
 * 渲染进程相当于 Electron 应用的前端页面，负责 UI 展示；与之对应的是 main 进程（Node 后端）和 preload 进程（桥梁脚本）。
 *
 * 这里把 @craft-agent/ui 包里的通用组件重新导出，方便本应用统一引用；
 * 同时导出 Electron 专属的 StreamingMarkdown 组件，用于流式（stream）回复场景。
 */

// 从 @craft-agent/ui 重新导出通用 Markdown 组件和类型
export { Markdown, MemoizedMarkdown, CollapsibleMarkdownProvider, CodeBlock, InlineCode, type MarkdownProps, type RenderMode } from '@craft-agent/ui'

// 导出 Electron 渲染进程本地的流式 Markdown 组件
export { StreamingMarkdown } from './StreamingMarkdown'
