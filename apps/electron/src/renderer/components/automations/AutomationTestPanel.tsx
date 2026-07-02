/**
 * AutomationTestPanel
 *
 * 内联面板，显示自动化测试执行结果。
 * 使用 Info_Alert 的变体保持样式一致。
 */

import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Info_Alert } from '@/components/info'
import { cn } from '@/lib/utils'
import type { TestResult } from './types'

export interface AutomationTestPanelProps {
  result: TestResult
  className?: string
}

export function AutomationTestPanel({ result, className }: AutomationTestPanelProps) {
  const { t } = useTranslation()
  if (result.state === 'idle') return null

  // 运行中
  if (result.state === 'running') {
    return (
      <div className={cn('flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground', className)}>
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t('automations.testRunning')}</span>
      </div>
    )
  }

  // 成功
  if (result.state === 'success') {
    return (
      <Info_Alert variant="success" icon={<CheckCircle2 className="h-4 w-4" />} className={className}>
        <Info_Alert.Title>
          {t('automations.testPassed')}
          {result.duration != null && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {result.duration}ms
            </span>
          )}
        </Info_Alert.Title>
      </Info_Alert>
    )
  }

  // 失败
  if (result.state === 'error') {
    return (
      <Info_Alert variant="error" icon={<XCircle className="h-4 w-4" />} className={className}>
        <Info_Alert.Title>{t('automations.testFailed')}</Info_Alert.Title>
        {result.stderr && (
          <Info_Alert.Description>
            <pre className="font-mono text-xs mt-1 whitespace-pre-wrap text-destructive">{result.stderr}</pre>
          </Info_Alert.Description>
        )}
      </Info_Alert>
    )
  }

  return null
}
