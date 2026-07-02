import type { SVGProps } from "react"

/**
 * TodoStateIcons —— 待办状态图标集合。
 *
 * 风格参考 SF Symbols / Linear，用于 Session 列表里的待办筛选下拉框。
 */

/**
 * 未开始状态：虚线空心圆。
 * 对应 SF Symbol "circle.dashed"。
 */
export function CircleDashed(props: SVGProps<SVGSVGElement>) {
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
      <circle cx="12" cy="12" r="9" strokeDasharray="4 3" />
    </svg>
  )
}

/**
 * 计划中状态：日历上加一个时钟徽标。
 * 对应 SF Symbol "calendar.badge.clock"。
 */
export function CalendarClock(props: SVGProps<SVGSVGElement>) {
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
      {/* 日历主体 */}
      <rect x="3" y="4" width="14" height="16" rx="2" />
      <path d="M7 2v4" />
      <path d="M13 2v4" />
      <path d="M3 9h14" />
      {/* 时钟徽标 */}
      <circle cx="18" cy="17" r="4" fill="currentColor" stroke="none" />
      <path d="M18 15v2l1 1" stroke="var(--background, white)" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * 待 review 状态：圆环中心带一个实心点。
 * 对应 SF Symbol "circle.circle" / target 图标。
 */
export function CircleEye(props: SVGProps<SVGSVGElement>) {
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
      <circle cx="12" cy="12" r="9" />
      {/* 中心点 */}
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * 进行中状态：左半边填充的圆。
 * 对应 SF Symbol "circle.lefthalf.filled" 和 Linear 的 in-progress 图标。
 */
export function CircleProgress(props: SVGProps<SVGSVGElement>) {
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
      <circle cx="12" cy="12" r="9" />
      {/* 左半边填充 */}
      <path
        d="M12 3a9 9 0 0 0 0 18"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  )
}

/**
 * 已完成状态：实心圆加对勾。
 * 对应 SF Symbol "checkmark.circle.fill" 和 Linear 的 done 图标。
 */
export function CircleCheckFilled(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path
        d="M8 12l3 3 5-5"
        fill="none"
        stroke="var(--background, white)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 已取消状态：实心圆加叉号。
 * 对应 SF Symbol "xmark.circle.fill" 和 Linear 的 cancelled 图标。
 */
export function CircleXFilled(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path
        d="M9 9l6 6M15 9l-6 6"
        fill="none"
        stroke="var(--background, white)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 全部状态：三条横向筛选线。
 * 对应 SF Symbol "line.3.horizontal.decrease"。
 */
export function FilterLines(props: SVGProps<SVGSVGElement>) {
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
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="6" y1="12" x2="18" y2="12" />
      <line x1="9" y1="18" x2="15" y2="18" />
    </svg>
  )
}
