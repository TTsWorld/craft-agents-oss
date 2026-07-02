/**
 * 自动化共享工具函数。
 *
 * Cron 辅助函数供 CronBuilder（可视化编辑器）和 AutomationInfoPage（信息展示）使用。
 * 时间格式化函数供 AutomationsListPanel 和 AutomationEventTimeline 共享。
 */

import { Cron } from 'croner'

/**
 * 把时间戳格式化为紧凑的相对时间（如 "3m"、"2h"、"5d"）。
 * AutomationsListPanel（尾部时间）和 AutomationEventTimeline 都会用到。
 */
export function formatShortRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (seconds < 60) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

/**
 * 把 cron 表达式转换为人类可读的文字描述。
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return 'Invalid schedule'

  const [minute, hour, dom, month, dow] = parts

  if (cron.trim() === '* * * * *') return 'Every minute'
  if (minute.startsWith('*/')) return `Every ${minute.slice(2)} minutes`
  if (hour === '*' && minute !== '*') return `Every hour at :${minute.padStart(2, '0')}`
  if (dom === '*' && month === '*') {
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    if (dow === '*') return `Daily at ${time}`
    if (dow === '1-5') return `Weekdays at ${time}`
    if (dow === '0,6') return `Weekends at ${time}`
    return `At ${time} (weekday: ${dow})`
  }
  if (month === '*' && dow === '*') {
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    return `Monthly on day ${dom} at ${time}`
  }
  return cron
}

/**
 * 使用 croner 库计算 cron 表达式的接下来 N 次运行时间。
 */
export function computeNextRuns(cron: string, count: number = 3): Date[] {
  try {
    const job = new Cron(cron)
    return job.nextRuns(count)
  } catch {
    return []
  }
}
