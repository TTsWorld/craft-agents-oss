/**
 * FabNewChat - 紧凑/移动端布局的悬浮新建聊天按钮。
 *
 * 固定在右下角、方便拇指点击；桌面端隐藏，由顶部栏菜单 + ⌘N 处理。
 * 通过 portal 渲染到 document.body，避免被 transform 祖先影响 fixed 定位。
 */
import { createPortal } from "react-dom"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

interface FabNewChatProps {
  onClick: () => void
  className?: string
}

/**
 * FabNewChat - 紧凑/移动端布局的悬浮新建聊天按钮。
 *
 * 固定在右下角、方便拇指点击；桌面端隐藏，由顶部栏菜单 + ⌘N 处理。
 * 通过 portal 渲染到 document.body，确保 position: fixed 以视口为基准。
 * 如果不使用 portal，FAB 会位于被 transform 的 motion.div（CompactPanelTransition）内部，
 * 而任何带 transform 的祖先都会成为 fixed 子元素的包含块，导致 FAB 错位到屏幕顶部而非底部。
 */
export function FabNewChat({ onClick, className }: FabNewChatProps) {
  const { t } = useTranslation()
  if (typeof document === 'undefined') return null
  return createPortal(
    <button
      type="button"
      onClick={onClick}
      aria-label={t("menu.newChat")}
      className={cn(
        "fixed right-4 z-30 size-14 rounded-full",
        "bg-accent text-white",
        "flex items-center justify-center",
        // 多层阴影：环境投影 + 主题色光晕 + 轻微内高光
        "shadow-[0_10px_30px_-8px_rgba(0,0,0,0.45),0_6px_18px_-6px_rgba(109,93,252,0.55),inset_0_1px_0_0_rgba(255,255,255,0.15)]",
        "transition-all duration-150",
        "hover:scale-105 hover:shadow-[0_14px_34px_-8px_rgba(0,0,0,0.5),0_8px_22px_-6px_rgba(109,93,252,0.65),inset_0_1px_0_0_rgba(255,255,255,0.2)]",
        "active:scale-95",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)]",
        className,
      )}
    >
      <Plus className="size-6 text-white" strokeWidth={2.5} />
    </button>,
    document.body,
  )
}
