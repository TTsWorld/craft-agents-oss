/**
 * EntityListEmptyScreen — 实体列表的通用空状态组件
 *
 * 把 Empty 系列原子组件封装成可配置的空状态，
 * 用于 Session（会话）、Source、Skill（技能）等列表为空时展示。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from './empty'
import { getDocUrl, type DocFeature } from '@craft-agent/shared/docs/doc-links'

export interface EntityListEmptyScreenProps {
  /** 空状态图标 */
  icon: React.ReactNode
  /** 标题 */
  title: string
  /** 描述文本 */
  description: string
  /** 文档 key，传了会自动渲染“了解更多”按钮 */
  docKey?: DocFeature
  /** 额外操作按钮，渲染在“了解更多”之后 */
  children?: React.ReactNode
  /** 容器额外 className */
  className?: string
}

/** 实体列表空状态 */
export function EntityListEmptyScreen({
  icon,
  title,
  description,
  docKey,
  children,
  className = 'flex-1',
}: EntityListEmptyScreenProps) {
  const { t } = useTranslation()
  const hasActions = docKey || children

  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {icon}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {hasActions && (
        <EmptyContent>
          {docKey && (
            <button
              onClick={() => window.electronAPI.openUrl(getDocUrl(docKey))}
              className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-foreground/[0.02] shadow-minimal hover:bg-foreground/[0.05] transition-colors"
            >
              {t("common.learnMore")}
            </button>
          )}
          {children}
        </EmptyContent>
      )}
    </Empty>
  )
}
