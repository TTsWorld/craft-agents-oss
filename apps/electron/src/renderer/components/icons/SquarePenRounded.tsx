import type { SVGProps } from "react"

/**
 * 自定义圆角方形编辑图标。
 *
 * 基于 Lucide 的 square-pen，但把方框的圆角半径从 2 加大到 4，视觉更柔和。
 */
export function SquarePenRounded(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* 圆角方框（圆角半径 4，原版为 2） */}
      <path d="M12 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-5" />
      {/* 铅笔部分（保持原样） */}
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
    </svg>
  )
}
