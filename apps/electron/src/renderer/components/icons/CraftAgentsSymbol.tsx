/** CraftAgentsSymbol 的 props */
interface CraftAgentsSymbolProps {
  className?: string
}

/**
 * Craft Agents 的“E”形像素小图标（品牌符号）。
 *
 * 同样使用 `currentColor`，由外层 className 控制颜色。
 */
export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <svg
      viewBox="452 368 115 129"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M474.78218,393.8 L474.78218,368 L566.666667,368 L566.666667,393.8 L474.78218,393.8 Z M521.101,419.6 L521.102306,445.4 L452,445.4 L452,393.8 L566.666667,393.8 L566.666667,419.6 L521.101,419.6 Z M474.78218,497 L474.775667,471.2 L452,471.2 L452,445.4 L566.666667,445.4 L566.666667,497 L474.78218,497 Z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  )
}
