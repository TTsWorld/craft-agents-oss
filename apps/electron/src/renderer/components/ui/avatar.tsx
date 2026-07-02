/**
 * 头像组件封装。
 * 提供基础 Avatar、AvatarImage、AvatarFallback，以及带淡入淡出效果的 CrossfadeAvatar。
 */
import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"
import { cn } from "@/lib/utils"

/** 头像容器组件。 */
function Avatar({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-10 shrink-0 overflow-hidden rounded-full",
        className
      )}
      {...props}
    />
  )
}

/** 头像图片组件。 */
function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square h-full w-full", className)}
      {...props}
    />
  )
}

/** 头像加载失败或无图时的占位组件。 */
function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-muted",
        className
      )}
      {...props}
    />
  )
}

/**
 * 带平滑过渡效果的头像组件。
 * 初始展示 fallback，图片加载完成后淡入；两个元素重叠在一起保证过渡自然。
 */
interface CrossfadeAvatarProps {
  src?: string | null       // 图片地址
  alt?: string              // 无障碍标签
  fallback: React.ReactNode // 加载前/失败时的占位内容
  className?: string
  fallbackClassName?: string
  imageClassName?: string
}

function CrossfadeAvatar({
  src,
  alt,
  fallback,
  className,
  fallbackClassName,
  imageClassName,
}: CrossfadeAvatarProps) {
  const [isLoaded, setIsLoaded] = React.useState(false)
  const [currentSrc, setCurrentSrc] = React.useState(src)

  // 判断当前图片是否为 SVG，SVG 使用背景图方式渲染以获得更好的缩放控制
  const isSvg = React.useMemo(() => src?.endsWith('.svg') ?? false, [src])

  // 当 src 变化时重置加载状态，但先检查新图是否已被浏览器缓存
  React.useEffect(() => {
    if (src !== currentSrc) {
      if (src) {
        const img = new Image()
        img.src = src
        if (img.complete && img.naturalWidth > 0) {
          // 图片已在缓存中，直接显示，不需要 fallback 过渡
          setCurrentSrc(src)
          setIsLoaded(true)
          return
        }
      }
      setIsLoaded(false)
      setCurrentSrc(src)
    }
  }, [src, currentSrc])

  // 回调 ref：在 img 元素挂载时立刻判断是否已缓存
  const imgCallbackRef = React.useCallback((node: HTMLImageElement | null) => {
    if (node && node.complete && node.naturalWidth > 0) {
      setIsLoaded(true)
    }
  }, [src])

  return (
    <div
      className={cn(
        "relative flex shrink-0 overflow-hidden",
        className
      )}
    >
      {/* Fallback：始终渲染，图片加载完成后淡出 */}
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity duration-200",
          isLoaded ? "opacity-0" : "opacity-100",
          fallbackClassName
        )}
      >
        {fallback}
      </div>

      {/* Image：加载完成后淡入 */}
      {src && (
        isSvg ? (
          // SVG 以背景图形式展示
          <div
            className={cn(
              "w-full h-full transition-opacity duration-200",
              isLoaded ? "opacity-100" : "opacity-0",
              imageClassName
            )}
            style={{
              backgroundImage: `url("${src}")`,
              backgroundSize: 'contain',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
            }}
            role="img"
            aria-label={alt}
          >
            {/* 隐藏的 img 仅用于触发加载事件与缓存 */}
            <img
              ref={imgCallbackRef}
              src={src}
              alt=""
              onLoad={() => setIsLoaded(true)}
              style={{ display: 'none' }}
            />
          </div>
        ) : (
          // 普通图片
          <img
            ref={imgCallbackRef}
            src={src}
            alt={alt}
            onLoad={() => setIsLoaded(true)}
            className={cn(
              "h-full w-full object-cover transition-opacity duration-200",
              isLoaded ? "opacity-100" : "opacity-0",
              imageClassName
            )}
          />
        )
      )}

      {/* 没有 src 时静态展示 fallback */}
      {!src && (
        <div
          className={cn(
            "flex h-full w-full items-center justify-center",
            fallbackClassName
          )}
        >
          {fallback}
        </div>
      )}
    </div>
  )
}

export { Avatar, AvatarImage, AvatarFallback, CrossfadeAvatar }
