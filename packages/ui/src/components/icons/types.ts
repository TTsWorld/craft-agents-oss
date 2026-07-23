import type { SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  /**
   * 图标尺寸。仅在 className 不包含尺寸类时生效。
   * 对于 Tailwind,建议使用 className="size-4" 等。
   */
  size?: number | string
}
