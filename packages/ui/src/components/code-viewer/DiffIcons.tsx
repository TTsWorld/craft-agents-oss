/**
 * DiffIcons - diff 查看器控件的 SVG 图标
 *
 * 图标取自 diffs.com，以保持与 @pierre/diffs 的视觉一致性
 */

import * as React from 'react'

interface IconProps {
  className?: string
}

/**
 * 分屏视图图标——并排展示两个面板
 * 当前处于 unified 模式时使用，点击切换到 split
 */
export function DiffSplitIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={className}
    >
      <path d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0" />
      <path
        d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1"
        opacity="0.3"
      />
    </svg>
  )
}

/**
 * Unified 视图图标——堆叠面板（新增在删除下方）
 * 当前处于 split 模式时使用，点击切换到 unified
 */
export function DiffUnifiedIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10"
        clipRule="evenodd"
      />
      <path
        fillRule="evenodd"
        d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z"
        clipRule="evenodd"
        opacity="0.4"
      />
    </svg>
  )
}

/**
 * 背景切换图标——中间带高亮框的线条
 * 切换变更行的背景高亮
 */
export function DiffBackgroundIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={className}
    >
      <path
        d="M0 2.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.25"
        opacity="0.4"
      />
      <path
        fillRule="evenodd"
        d="M15 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2.5 9a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0-2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1z"
        clipRule="evenodd"
      />
      <path
        d="M0 14.75A.75.75 0 0 1 .75 14h5.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75"
        opacity="0.4"
      />
    </svg>
  )
}
