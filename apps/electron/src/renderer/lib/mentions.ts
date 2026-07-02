/**
 * 解析消息中的 [方括号] mention。
 *
 * Mention 类型：
 * - Skill：  [skill:slug]
 * - Source： [source:slug]
 *
 * 方括号语法允许在不依赖词边界的情况下，把 mention 放在文本任意位置。
 */

import type { ContentBadge } from '@craft-agent/core'
import type { MentionItemType } from '@/components/ui/mention-menu'
import type { LoadedSkill, LoadedSource } from '../../shared/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'
import { getSourceIconSync, getSkillIconSync } from './icon-cache'

// 从 shared 导入纯字符串解析函数（不依赖渲染进程上下文）并重新导出
import { parseMentions, stripAllMentions, resolveSkillMentions, resolveSourceMentions, type ParsedMentions } from '@craft-agent/shared/mentions'
export { parseMentions, stripAllMentions, resolveSkillMentions, resolveSourceMentions, type ParsedMentions }

// ============================================================================
// 常量
// ============================================================================

// 工作区 ID 可用字符：单词字符、空格（不含换行）、连字符、点号
// 用字面空格替代 \s，避免匹配换行导致解析异常
const WS_ID_CHARS = '[\\w .-]'

// ============================================================================
// 类型
// ============================================================================

export interface MentionMatch {
  type: MentionItemType
  id: string
  /** 包含 @ 前缀的完整匹配文本 */
  fullMatch: string
  /** 在原始文本中的起始索引 */
  startIndex: number
}

// ============================================================================
// 匹配函数（渲染进程专用，使用 MentionItemType）
// ============================================================================

/**
 * 在文本中查找所有 mention 及其位置。
 *
 * @param text - 要搜索的消息文本
 * @param availableSkillSlugs - 有效的 skill slug 列表
 * @param availableSourceSlugs - 有效的 source slug 列表
 * @returns 带位置的 mention 匹配数组
 */
export function findMentionMatches(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): MentionMatch[] {
  const matches: MentionMatch[] = []

  // 匹配 source mention：[source:slug]
  const sourcePattern = /(\[source:([\w-]+)\])/g
  let match
  while ((match = sourcePattern.exec(text)) !== null) {
    const slug = match[2]
    if (availableSourceSlugs.includes(slug)) {
      matches.push({
        type: 'source',
        id: slug,
        fullMatch: match[1],
        startIndex: match.index,
      })
    }
  }

  // 匹配 skill mention：[skill:slug] 或 [skill:workspaceId:slug]
  // 捕获完整匹配文本，并提取最后一个冒号后的 slug
  // 工作区 ID 可包含空格、连字符、下划线和点号
  const skillPattern = new RegExp(`(\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\])`, 'g')
  while ((match = skillPattern.exec(text)) !== null) {
    const slug = match[2]
    if (availableSkillSlugs.includes(slug)) {
      matches.push({
        type: 'skill',
        id: slug,
        fullMatch: match[1],
        startIndex: match.index,
      })
    }
  }

  // 匹配 file mention：[file:path]
  const filePattern = /(\[file:([^\]]+)\])/g
  while ((match = filePattern.exec(text)) !== null) {
    matches.push({
      type: 'file',
      id: match[2],
      fullMatch: match[1],
      startIndex: match.index,
    })
  }

  // 匹配 folder mention：[folder:path]
  const folderPattern = /(\[folder:([^\]]+)\])/g
  while ((match = folderPattern.exec(text)) !== null) {
    matches.push({
      type: 'folder',
      id: match[2],
      fullMatch: match[1],
      startIndex: match.index,
    })
  }

  // 按位置排序
  return matches.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * 从文本中移除指定的 mention。
 *
 * @param text - 消息文本
 * @param type - 要移除的 mention 类型
 * @param id - mention 的 ID（slug 或路径）
 * @returns 移除后的文本
 */
export function removeMention(text: string, type: MentionItemType, id: string): string {
  let pattern: RegExp

  switch (type) {
    case 'source':
      pattern = new RegExp(`\\[source:${escapeRegExp(id)}\\]`, 'g')
      break
    case 'file':
      pattern = new RegExp(`\\[file:${escapeRegExp(id)}\\]`, 'g')
      break
    case 'folder':
      pattern = new RegExp(`\\[folder:${escapeRegExp(id)}\\]`, 'g')
      break
    case 'skill':
    default:
      // 同时匹配 [skill:slug] 和 [skill:workspaceId:slug]
      pattern = new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?${escapeRegExp(id)}\\]`, 'g')
      break
  }

  return text
    .replace(pattern, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 检查文本中是否包含任何有效 mention。
 */
export function hasMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): boolean {
  const mentions = parseMentions(text, availableSkillSlugs, availableSourceSlugs)
  return mentions.skills.length > 0 || mentions.sources.length > 0 || mentions.files.length > 0 || mentions.folders.length > 0
}

// ============================================================================
// 旧版兼容 - parseSkillMentions
// ============================================================================

/**
 * 从消息文本中提取有效的 [skill:...] mention（旧版 API）。
 *
 * @deprecated 请改用 parseMentions()
 */
export function parseSkillMentions(text: string, availableSlugs: string[]): string[] {
  return parseMentions(text, availableSlugs, []).skills
}

/**
 * 从消息文本中移除 [方括号] mention（旧版 API）。
 *
 * @deprecated 请改用 stripAllMentions()
 */
export function stripSkillMentions(text: string): string {
  return stripAllMentions(text)
}

// ============================================================================
// Badge 提取
// ============================================================================

/**
 * 从消息文本中提取 ContentBadge 数组。
 * 发送消息时调用，用于把 badge 的展示元数据附带出去。
 *
 * 每个 badge 自包含 label、icon（base64）和位置信息。
 *
 * @param text - 带 mention 的消息文本
 * @param skills - 可用 skills（用于查 label）
 * @param sources - 可用 sources（用于查 label）
 * @param workspaceId - 工作区 ID（用于查 icon）
 * @returns ContentBadge 数组
 */
export function extractBadges(
  text: string,
  skills: LoadedSkill[],
  sources: LoadedSource[],
  workspaceId: string
): ContentBadge[] {
  const skillSlugs = skills.map(s => s.slug)
  const sourceSlugs = sources.map(s => s.config.slug)
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)

  // 构建查找映射，避免每条 match 都线性扫描
  const skillsBySlug = new Map(skills.map(s => [s.slug, s]))
  const sourcesBySlug = new Map(sources.map(s => [s.config.slug, s]))

  return matches.map(match => {
    let label = match.id
    let iconDataUrl: string | undefined
    let filePath: string | undefined

    if (match.type === 'skill') {
      const skill = skillsBySlug.get(match.id)
      label = skill?.metadata.name || match.id

      // 从缓存取 data URL 形式的 icon（保留 SVG/PNG 等 mime 类型）
      iconDataUrl = getSkillIconSync(workspaceId, match.id) ?? undefined
    } else if (match.type === 'source') {
      const source = sourcesBySlug.get(match.id)
      label = source?.config.name || match.id

      // 从缓存取 data URL 形式的 icon
      iconDataUrl = getSourceIconSync(workspaceId, match.id) ?? undefined
    } else if (match.type === 'file') {
      // label 显示文件名，filePath 存完整相对路径用于 tooltip
      label = match.id.split('/').pop() || match.id
      filePath = match.id
    } else if (match.type === 'folder') {
      // label 显示文件夹名，filePath 存完整相对路径用于 tooltip
      label = match.id.split('/').pop() || match.id
      filePath = match.id
    }

    // 对 skill 生成完全限定的 rawText（pluginName:slug），
    // 这样 agent 收到的是 SDK Skill 工具需要的格式。
    // pluginName 取决于 skill 来源：workspace → workspaceId；project/global → AGENTS_PLUGIN_NAME
    let rawText = match.fullMatch
    if (match.type === 'skill') {
      const skill = skillsBySlug.get(match.id)
      const pluginName = skill?.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
      rawText = `[skill:${pluginName}:${match.id}]`
    }

    return {
      type: match.type as 'source' | 'skill' | 'file' | 'folder',
      label,
      rawText,
      iconDataUrl,
      filePath,
      start: match.startIndex,
      end: match.startIndex + match.fullMatch.length,
    }
  })
}

// ============================================================================
// 辅助函数
// ============================================================================

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
