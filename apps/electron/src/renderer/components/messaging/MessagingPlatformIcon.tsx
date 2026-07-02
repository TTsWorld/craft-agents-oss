/**
 * MessagingPlatformIcon
 *
 * 与 LLM provider 用的 ConnectionIcon 类似，但面向消息平台。
 * 渲染 Telegram / WhatsApp / Lark 的品牌图标；如果 SVG import 在运行时失败，
 * 则回退到带平台首字母的彩色徽标。
 *
 * `assets/messaging-icons/` 里的 SVG 是为原型简化的品牌标识；
 * 生产环境应替换为各平台官方 press kit 中的标准徽标。
 */

import telegramIcon from '@/assets/messaging-icons/telegram.svg'
import whatsappIcon from '@/assets/messaging-icons/whatsapp.svg'
import larkIcon from '@/assets/messaging-icons/lark.svg'

type MessagingPlatform = 'telegram' | 'whatsapp' | 'lark'

const platformIcons: Record<MessagingPlatform, string> = {
  telegram: telegramIcon,
  whatsapp: whatsappIcon,
  lark: larkIcon,
}

const platformFallback: Record<MessagingPlatform, { bg: string; initial: string }> = {
  telegram: { bg: '#229ED9', initial: 'T' },
  whatsapp: { bg: '#25D366', initial: 'W' },
  lark: { bg: '#00D6B9', initial: 'L' },
}

interface MessagingPlatformIconProps {
  platform: MessagingPlatform
  // 图标边长，单位像素（默认 16）
  size?: number
  className?: string
}

export function MessagingPlatformIcon({
  platform,
  size = 16,
  className = '',
}: MessagingPlatformIconProps) {
  const src = platformIcons[platform]
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={`rounded-[3px] flex-shrink-0 ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  const { bg, initial } = platformFallback[platform]
  return (
    <div
      className={`rounded-[3px] flex items-center justify-center flex-shrink-0 text-white font-semibold ${className}`}
      style={{ width: size, height: size, backgroundColor: bg, fontSize: Math.round(size * 0.6) }}
    >
      {initial}
    </div>
  )
}
