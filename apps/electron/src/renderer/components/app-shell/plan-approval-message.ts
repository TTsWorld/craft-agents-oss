/**
 * plan-approval-message — UI 组件
 * 
 * 所属目录：app-shell
 */
import i18n from 'i18next'
import { coerceInputText } from '@/lib/input-text'

/** BuildPlanApprovalMessageOptions：构建 Plan Approval 消息的选项 */
export interface BuildPlanApprovalMessageOptions {
  /** 已接受的 plan 路径（为兼容旧调用点保留，实际消息内容不依赖该路径） */
  planPath?: string
  /** 用户额外输入的草稿内容 */
  draftInput?: string
}

/** 清洗用户输入：统一输入格式后去除首尾空白 */
function normalizeDraftInput(input?: string): string {
  return coerceInputText(input).trim()
}

/**
 * buildPlanApprovalMessage - 组装用户批准 plan 后发送给 agent 的消息。
 * 包含固定的批准文案，如果有补充上下文则追加一段 markdown。
 */
export function buildPlanApprovalMessage(options: BuildPlanApprovalMessageOptions = {}): string {
  const draftInput = normalizeDraftInput(options.draftInput)

  const sections: string[] = [i18n.t('plan.approved')]

  if (draftInput.length > 0) {
    sections.push(['---', `**${i18n.t('plan.additionalUserContext')}**`, draftInput].join('\n\n'))
  }

  return sections.join('\n\n')
}
