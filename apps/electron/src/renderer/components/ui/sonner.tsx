/**
 * Sonner Toaster —— 全局 Toast 通知组件
 *
 * 基于 sonner 库封装，跟随当前主题（light/dark），并隐藏默认图标以保持设计一致。
 */
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/context/ThemeContext"

// 空组件：用于隐藏所有 toast 图标
const NoIcon = () => <></>

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedMode } = useTheme()

  return (
    <Sonner
      theme={resolvedMode as ToasterProps["theme"]}
      position="top-right"
      closeButton
      richColors={false}
      swipeDirections={["right"]}
      className="toaster group"
      icons={{
        success: <NoIcon />,
        info: <NoIcon />,
        warning: <NoIcon />,
        error: <NoIcon />,
        loading: <NoIcon />,
      }}
      toastOptions={{
        className: "!rounded-xl !backdrop-blur-xl group",
      }}
      style={
        {
          "--normal-bg": "transparent",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
