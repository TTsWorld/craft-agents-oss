/**
 * EmptyStateHint - 空聊天气泡的“灵感提示”组件
 *
 * 当聊天窗口为空时，随机展示一条可用工作流示例，并在文本中插入 source、file、folder、skill 等实体徽标。
 * 该组件运行在 Electron renderer 进程（可以理解为桌面应用的“前端”），使用 React + TSX 编写。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

// ============================================================================
// 类型定义
// ============================================================================

/** 提示语中可能出现的实体类型 */
type EntityType = 'source' | 'file' | 'folder' | 'skill'

/**
 * 将提示语切分后的片段
 * - text: 普通文本
 * - entity: 需要渲染成徽标的实体（source 可带 provider 以区分具体服务）
 */
type HintSegment =
  | { type: 'text'; content: string }
  | { type: 'entity'; entityType: EntityType; label: string; provider?: string }

/** 一条解析后的提示语，包含唯一 id 和若干片段 */
interface ParsedHint {
  id: string
  segments: HintSegment[]
}

// ============================================================================
// 提示语模板
// ============================================================================

/**
 * i18n 模板 key 列表。
 * 实际文案由 react-i18next 从翻译文件中读取，这里只列出所有可能的工作流场景。
 * 模板中可包含占位符，例如 {source:Gmail}、{file:screenshot}、{folder}、{skill}。
 */
const HINT_TEMPLATE_KEYS = [
  'hints.summarizeGmail',
  'hints.screenshotToWebsite',
  'hints.pullIssuesLinear',
  'hints.transcribeVoiceMemo',
  'hints.analyzeSpreadsheet',
  'hints.reviewGitHubPRs',
  'hints.parseInvoicePDF',
  'hints.researchExa',
  'hints.refactorCode',
  'hints.syncCalendar',
  'hints.meetingNotesToTickets',
  'hints.queryDatabase',
  'hints.fetchFigmaDesigns',
  'hints.combineSlackThreads',
  'hints.runSkillAnalyze',
]

// ============================================================================
// 解析模板
// ============================================================================

/**
 * 将单条提示语模板解析为 ParsedHint。
 * 通过正则匹配 {type} 或 {type:label}，把文本和实体拆成有序片段。
 */
function parseHintTemplate(template: string, id: string): ParsedHint {
  const segments: HintSegment[] = []
  // 正则捕获 {source|file|folder|skill} 以及可选的 :label
  const tokenRegex = /\{(source|file|folder|skill)(?::([^}]+))?\}/g

  let lastIndex = 0
  let match

  while ((match = tokenRegex.exec(template)) !== null) {
    // token 之前的普通文本
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: template.slice(lastIndex, match.index),
      })
    }

    const entityType = match[1] as EntityType
    const labelOrProvider = match[2]

    // source 的 label 同时用于显示和 provider 判断；其余类型仅作为显示 label
    if (entityType === 'source') {
      segments.push({
        type: 'entity',
        entityType,
        label: labelOrProvider || 'source',
        provider: labelOrProvider?.toLowerCase(),
      })
    } else {
      segments.push({
        type: 'entity',
        entityType,
        label: labelOrProvider || entityType,
      })
    }

    lastIndex = match.index + match[0].length
  }

  // 剩余文本
  if (lastIndex < template.length) {
    segments.push({
      type: 'text',
      content: template.slice(lastIndex),
    })
  }

  return { id, segments }
}

/**
 * 使用翻译函数 t() 解析所有提示语模板。
 * 当语言切换导致 t 函数变化时，会重新解析。
 */
function parseAllHints(t: (key: string) => string): ParsedHint[] {
  return HINT_TEMPLATE_KEYS.map((key, index) => parseHintTemplate(t(key), `hint-${index}`))
}

// ============================================================================
// 实体徽标子组件
// ============================================================================

/** EntityBadge 的 props：实体类型、显示文字、可选 provider */
interface EntityBadgeProps {
  entityType: EntityType
  label: string
  provider?: string
}

/**
 * EntityBadge - 内联实体徽标
 *
 * 用带圆角和浅背景的小标签展示实体名称。当前 provider 未参与样式，保留字段供以后扩展。
 */
function EntityBadge({ label }: EntityBadgeProps) {
  return (
    <span className="inline-flex pl-[8px] pr-[10px] py-0.5 mx-[2px] rounded-[8px] bg-foreground/5 shadow-minimal text-foreground/40">
      {label}
    </span>
  )
}

// ============================================================================
// 主组件
// ============================================================================

export interface EmptyStateHintProps {
  /** 指定显示第几条提示（测试/Playground 用） */
  hintIndex?: number
  /** 自定义外层 className */
  className?: string
}

/**
 * EmptyStateHint - 展示随机工作流提示
 *
 * 组件挂载时随机选择一条提示，也可通过 hintIndex 指定。
 * 使用 React.useMemo 缓存解析结果，避免每次渲染都重新切分字符串。
 */
export function EmptyStateHint({ hintIndex, className }: EmptyStateHintProps) {
  const { t } = useTranslation()
  // 解析全部提示语；仅在 t 变化时重新执行
  const allHints = React.useMemo(() => parseAllHints(t), [t])

  // 初始化时随机选择一条；如果外部传了 hintIndex，则以传入值为准
  const [selectedIndex] = React.useState(() => {
    if (hintIndex !== undefined && hintIndex >= 0 && hintIndex < allHints.length) {
      return hintIndex
    }
    return Math.floor(Math.random() * allHints.length)
  })

  // 当 hintIndex prop 变化时，显示指定提示
  const displayIndex = hintIndex !== undefined ? hintIndex : selectedIndex
  const hint = allHints[displayIndex % allHints.length]

  return (
    <div
      className={cn(
        'text-center leading-relaxed tracking-tight',
        'max-w-md mx-auto select-none',
        'text-[20px] font-bold text-black',
        className
      )}
    >
      {hint.segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.content}</span>
        }

        return (
          <EntityBadge
            key={index}
            entityType={segment.entityType}
            label={segment.label}
            provider={segment.provider}
          />
        )
      })}
    </div>
  )
}

/** 返回当前可用的提示总数（供 Playground 生成变体用） */
export function getHintCount(): number {
  return HINT_TEMPLATE_KEYS.length
}

/** 按索引返回提示模板 i18n key（调试用） */
export function getHintTemplate(index: number): string {
  return HINT_TEMPLATE_KEYS[index % HINT_TEMPLATE_KEYS.length]
}
