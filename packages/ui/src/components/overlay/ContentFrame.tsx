/**
 * ContentFrame - 所有预览浮层共享的终端风格卡片框架
 *
 * 提供"应用窗口"外观：圆角卡片带居中标题栏，
 * 在 bg-foreground-3 背景上居中。支持可选的左右边栏，
 * 渲染在卡片外部（例如 MultiDiffPreviewOverlay 中的文件导航）。
 *
 * 卡片始终在视口中居中。边栏使用绝对定位，
 * 挂在卡片边缘外侧，不影响卡片的居中位置。
 *
 * 卡片会随内容自适应高度——没有内部滚动。当卡片高度超过视口时，
 * 由父级滚动容器（FullscreenOverlayBase 或 PreviewOverlay 的 contentArea 提供）
 * 滚动整个卡片（"纸张滚动"）。
 * 使用 margin:auto 居心，能优雅处理溢出（不像 items-center 会裁剪溢出内容的顶部）。
 *
 * 宽度模式：
 *   - 默认：卡片填充可用宽度，上限为 maxWidth（数值，默认 850px）。
 *   - fitContent：卡片使用 CSS `width: max-content` 随内容宽度增长。
 *     适用于可变宽度内容的浮层（如 diff 表格）。上限为外层容器的 100%，
 *     下限为 minWidth。比 JS 测量更可靠，因为对异步渲染内容（Shiki 语法高亮）同样有效。
 *
 * 布局（基于流式布局——位于父级的滚动容器内）：
 *   flex, px-6, min-h-full
 *     └── relative wrapper (max-w constrained, m-auto centered, grows to content)
 *          ├── leftSidebar?  (absolute, right-full — hangs left of card)
 *          ├── Card (rounded-2xl, bg-background, shadow-strong, grows to content)
 *          │    ├── Title bar (centered title label)
 *          │    └── children (grows naturally)
 *          └── rightSidebar? (absolute, left-full — hangs right of card)
 *
 * 使用方：TerminalPreviewOverlay, CodePreviewOverlay, GenericOverlay,
 *         JSONPreviewOverlay, MultiDiffPreviewOverlay
 */

import type { ReactNode } from 'react'

export interface ContentFrameProps {
  /** 标题栏标签，居中显示在标题栏中 */
  title: string
  /** 卡片最大宽度（默认：850）。边栏不受此限制。
   *  fitContent 为 true 时忽略此项（卡片使用 max-content 宽度）。 */
  maxWidth?: number
  /** 卡片最小宽度。仅在 fitContent 为 true 时生效。 */
  minWidth?: number
  /** 为 true 时，卡片使用 CSS `width: max-content` 自然撑开至内容宽度
   *  （如宽 diff 表格）。卡片上限为视口的 100%（减去内边距），下限为 minWidth。
   *  比 JS 测量更可靠，因为对异步渲染内容（Shiki）同样有效。 */
  fitContent?: boolean
  /** 渲染在卡片左侧的可选内容（如侧边导航） */
  leftSidebar?: ReactNode
  /** 渲染在卡片右侧的可选内容 */
  rightSidebar?: ReactNode
  /** 渲染在卡片内部、标题栏下方的内容 */
  children: ReactNode
}

export function ContentFrame({
  title,
  maxWidth = 850,
  minWidth,
  fitContent,
  leftSidebar,
  rightSidebar,
  children,
}: ContentFrameProps) {
  // fitContent 模式：卡片使用 CSS max-content 宽度撑开至内容宽度（如宽 diff）。
  // 上限为外层容器的 100%，确保永不超过视口。
  // 默认模式：卡片填充可用宽度，上限为 maxWidth（固定/数值）。
  const wrapperStyle = fitContent
    ? { width: 'max-content' as const, maxWidth: '100%', minWidth }
    : { maxWidth }

  return (
    <div className="flex px-6">
      {/* 相对定位包裹层——通过 mx-auto 水平居中。垂直居中由父级处理
          （FullscreenOverlayBase 的居中包裹层）。卡片随内容自适应高度。 */}
      <div
        className={`relative mx-auto ${fitContent ? '' : 'w-full'}`}
        style={wrapperStyle}
      >
        {/* 左侧边栏——绝对定位在卡片左侧 */}
        {leftSidebar && (
          <div className="absolute right-full top-0 h-full mr-4 overflow-y-auto">
            {leftSidebar}
          </div>
        )}

        {/* 主卡片——随内容自适应高度，无内部滚动 */}
        <div className="flex flex-col rounded-2xl overflow-hidden backdrop-blur-sm shadow-strong bg-background min-h-[320px]">
          {/* 标题栏 */}
          <div className="flex justify-center items-center px-4 py-3 border-b border-foreground/7 select-none shrink-0">
            <div className="text-xs font-semibold tracking-wider text-foreground/30">
              {title}
            </div>
          </div>

          {/* 内容区——随内容自然增长，无滚动约束 */}
          <div>
            {children}
          </div>
        </div>

        {/* 右侧边栏——绝对定位在卡片右侧 */}
        {rightSidebar && (
          <div className="absolute left-full top-0 h-full ml-4 overflow-y-auto">
            {rightSidebar}
          </div>
        )}
      </div>
    </div>
  )
}
