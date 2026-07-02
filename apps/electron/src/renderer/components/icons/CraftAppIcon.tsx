import craftLogo from "@/assets/craft_logo_c.svg"

/** CraftAppIcon 的 props */
interface CraftAppIconProps {
  className?: string
  size?: number
}

/**
 * CraftAppIcon —— 显示 Craft 彩色 "C" Logo。
 *
 * 这里通过 `<img>` 引入 SVG 资源，适合需要固定尺寸、不需要随主题变色的场景。
 */
export function CraftAppIcon({ className, size = 64 }: CraftAppIconProps) {
  return (
    <img
      src={craftLogo}
      alt="Craft"
      width={size}
      height={size}
      className={className}
    />
  )
}
