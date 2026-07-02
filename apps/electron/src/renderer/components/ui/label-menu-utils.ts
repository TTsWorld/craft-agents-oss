/**
 * 标签菜单工具函数。
 * 负责把嵌套标签结构拍平成可搜索的菜单项，并提供按层级路径过滤的能力。
 */
import type { LabelConfig } from '@craft-agent/shared/labels'
import { flattenLabelsWithParentPath } from '@craft-agent/shared/labels'

/** 标签菜单项类型。 */
export interface LabelMenuItem {
  id: string
  label: string
  config: LabelConfig
  /** 嵌套标签的面包屑路径，例如 "Priority / "。 */
  parentPath?: string
}

// 用于菜单项排序的国际化比较器，忽略大小写和重音差异
const labelMenuCollator = new Intl.Collator(undefined, { sensitivity: 'base' })

/** 比较两个标签菜单项的排序顺序。 */
export function compareLabelMenuItems(a: LabelMenuItem, b: LabelMenuItem): number {
  return labelMenuCollator.compare(a.label, b.label)
    || labelMenuCollator.compare(a.parentPath ?? '', b.parentPath ?? '')
    || a.id.localeCompare(b.id)
}

/**
 * 把嵌套标签结构拍平为带父路径的菜单项。
 * 这里统一处理排除逻辑，这样行内 # 菜单与 AppShell 的过滤搜索可以共用同一套拍平和路径构建逻辑。
 */
export function createLabelMenuItems(labels: LabelConfig[], excludedLabelIds: Iterable<string> = []): LabelMenuItem[] {
  const excluded = new Set(excludedLabelIds)

  return flattenLabelsWithParentPath(labels)
    .filter(({ label }) => !excluded.has(label.id))
    .map(({ label, parentPath }) => ({
      id: label.id,
      label: label.name,
      config: label,
      parentPath,
    }))
    .sort(compareLabelMenuItems)
}

/**
 * 计算一个路径片段与搜索词的匹配得分。
 * 3 = 以搜索词开头（最佳，例如 "pri" 匹配 "Priority"）
 * 2 = 词边界匹配（空格/连字符/下划线后，例如 "high" 匹配 "super-high"）
 * 1 = 任意位置包含（词中，例如 "ior" 匹配 "Priority"）
 * 0 = 无匹配
 */
export function segmentScore(part: string, segment: string): number {
  const lower = part.toLowerCase()
  if (lower.startsWith(segment)) return 3
  if (new RegExp(`[\\s\\-_]${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lower)) return 2
  if (lower.includes(segment)) return 1
  return 0
}

/**
 * 统一的层级过滤函数，支持按匹配度排序。
 * 把搜索词按 "/" 拆分成多个片段（没有 "/" 时只有一个片段），
 * 然后按顺序在每个菜单项的完整路径（父路径片段 + 当前标签名）中依次匹配，
 * 最终按总分从高到低排序（开头匹配 > 词边界匹配 > 包含匹配）。
 */
export function filterItems(items: LabelMenuItem[], filter: string): LabelMenuItem[] {
  if (!filter) return [...items].sort(compareLabelMenuItems)

  // 拆分并清理搜索片段
  const segments = filter.toLowerCase().split('/').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return [...items].sort(compareLabelMenuItems)

  const scored: { item: LabelMenuItem; score: number }[] = []

  for (const item of items) {
    // 把 parentPath "A / B" 拆成 ["A", "B"]
    const parentParts = item.parentPath
      ? item.parentPath.split(' / ').filter(Boolean)
      : []
    const fullParts = [...parentParts, item.label]

    let totalScore = 0
    let partIndex = 0
    let matched = true

    // 每个搜索片段都要按顺序命中完整路径中的某一部分
    for (const seg of segments) {
      let bestScore = 0
      let found = false
      while (partIndex < fullParts.length) {
        const score = segmentScore(fullParts[partIndex], seg)
        if (score > 0) {
          bestScore = score
          found = true
          partIndex++
          break
        }
        partIndex++
      }
      if (!found) {
        matched = false
        break
      }
      totalScore += bestScore
    }

    if (matched) {
      scored.push({ item, score: totalScore })
    }
  }

  // 先按得分降序，得分相同再按默认菜单顺序
  scored.sort((a, b) => b.score - a.score || compareLabelMenuItems(a.item, b.item))
  return scored.map(s => s.item)
}
