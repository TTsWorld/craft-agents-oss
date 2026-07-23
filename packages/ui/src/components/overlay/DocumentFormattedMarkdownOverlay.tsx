/**
 * DocumentFormattedMarkdownOverlay - 用于阅读 AI 回复和计划的全屏视图
 *
 * 以文档化格式渲染 markdown 内容，包括：
 * - 带最大宽度的居中内容卡片
 * - 通过 FullscreenOverlayBase 内置的 copyContent 属性提供复制按钮
 * - 可选的"计划"头部变体
 * - 可选的 filePath 徽标，带双触发菜单（打开 / 在 {文件管理器} 中显示）
 *
 * 背景和景深模糊由 FullscreenOverlayBase 提供。
 * 使用 FullscreenOverlayBase 处理 portal、交通灯按钮、ESC 键和头部。
 */

import { ListTodo } from 'lucide-react'
import { Markdown } from '../markdown'
import type { AnnotationV1 } from '@craft-agent/core'
import type { ExternalOpenAnnotationRequest } from '../annotations/use-annotation-interaction-controller'
import { FullscreenOverlayBase } from './FullscreenOverlayBase'
import type { OverlayTypeBadge } from './FullscreenOverlayBaseHeader'
import { AnnotatableMarkdownDocument } from './AnnotatableMarkdownDocument'

export interface DocumentFormattedMarkdownOverlayProps {
  /** 要显示的内容（markdown） */
  content: string
  /** 浮层是否打开 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 变体：'response'（默认）或 'plan'（显示头部） */
  variant?: 'response' | 'plan'
  /** URL 点击回调 */
  onOpenUrl?: (url: string) => void
  /** 文件路径点击回调 */
  onOpenFile?: (path: string) => void
  /** 可选文件路径——显示带"打开"/"在 {文件管理器} 中显示"菜单的徽标 */
  filePath?: string
  /** 可选类型徽标——工具/格式标识（如"Write"），显示在头部 */
  typeBadge?: OverlayTypeBadge
  /** 可选错误信息——在内容卡片上方渲染带色调的错误横幅 */
  error?: string
  /** 可选会话 id，用于标注负载的来源元数据 */
  sessionId?: string
  /** 可选消息 id；与回调同时存在时，浮层变为可标注 */
  messageId?: string
  /** 该消息的持久化标注 */
  annotations?: AnnotationV1[]
  /** 添加标注的回调 */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** 删除标注的回调 */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** 更新标注的回调 */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** 追问编辑器使用的输入发送键行为 */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** 源内容是否正在流式输出（影响标注资格的一致性） */
  isStreaming?: boolean
  /** 可选的外部打开特定标注的请求 */
  openAnnotationRequest?: ExternalOpenAnnotationRequest | null
}

export function DocumentFormattedMarkdownOverlay({
  content,
  isOpen,
  onClose,
  variant = 'response',
  onOpenUrl,
  onOpenFile,
  filePath,
  typeBadge,
  error,
  sessionId,
  messageId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  isStreaming = false,
  openAnnotationRequest,
}: DocumentFormattedMarkdownOverlayProps) {
  return (
    <FullscreenOverlayBase
      isOpen={isOpen}
      onClose={onClose}
      filePath={filePath}
      typeBadge={typeBadge}
      copyContent={content}
      error={error ? { label: 'Write Failed', message: error } : undefined}
    >
      {/* 内容包裹层——min-h-full 用于在 FullscreenOverlayBase 的滚动容器中垂直居中。
          滚动和渐变遮罩由 FullscreenOverlayBase 处理。 */}
      <div className="min-h-full flex flex-col justify-center px-6 py-16">
        {/* 内容卡片——内容较小时通过 my-auto 垂直居中，内容较大时自然流动 */}
        <div className="bg-background rounded-[16px] shadow-strong w-full max-w-[960px] h-fit mx-auto my-auto">
          {/* 计划头部（仅 variant="plan" 时） */}
          {variant === 'plan' && (
            <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2 bg-success/5 rounded-t-[16px]">
              <ListTodo className="w-3 h-3 text-success" />
              <span className="text-[13px] font-medium text-success">Plan</span>
            </div>
          )}

          {/* 内容区 */}
          <div className="px-10 pt-8 pb-8">
            <div className="text-sm">
              {messageId && onAddAnnotation ? (
                <AnnotatableMarkdownDocument
                  content={content}
                  sessionId={sessionId}
                  messageId={messageId}
                  annotations={annotations}
                  onAddAnnotation={onAddAnnotation}
                  onRemoveAnnotation={onRemoveAnnotation}
                  onUpdateAnnotation={onUpdateAnnotation}
                  onOpenUrl={onOpenUrl}
                  onOpenFile={onOpenFile}
                  sendMessageKey={sendMessageKey}
                  islandZIndex={420}
                  openAnnotationRequest={openAnnotationRequest}
                  isStreaming={isStreaming}
                />
              ) : (
                <Markdown
                  mode="minimal"
                  onUrlClick={onOpenUrl}
                  onFileClick={onOpenFile}
                  hideFirstMermaidExpand={false}
                >
                  {content}
                </Markdown>
              )}
            </div>
          </div>
        </div>
      </div>
    </FullscreenOverlayBase>
  )
}
