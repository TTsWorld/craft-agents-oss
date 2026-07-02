/**
 * ActionTypeIcon
 *
 * 根据动作类型显示对应的小图标：
 * - webhook: Webhook 图标
 * - prompt: 消息气泡图标
 */

import { MessageSquare, Webhook } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ActionTypeIcon({ type, className }: { type: 'prompt' | 'webhook'; className?: string }) {
  const Icon = type === 'webhook' ? Webhook : MessageSquare
  return <Icon className={cn('text-foreground/50', className)} />
}
