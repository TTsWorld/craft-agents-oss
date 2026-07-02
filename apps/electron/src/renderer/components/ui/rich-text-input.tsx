/**
 * RichTextInput — 支持 @mention 的富文本输入框
 *
 * 这是一个 contentEditable div，不是 textarea。
 * 它能在文本中识别 @skill、@source、文件/文件夹路径，并渲染成内联徽章（badge），
 * 同时保持底层文本模型仍是纯字符串，方便传给 Agent 处理。
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { coerceInputText } from '@/lib/input-text'
import { cn } from '@/lib/utils'
import { findMentionMatches, parseMentions, type MentionMatch } from '@/lib/mentions'
import {
  loadSourceIcon,
  loadSkillIcon,
  getSourceIconSync,
  getSkillIconSync,
  EMOJI_ICON_PREFIX,
} from '@/lib/icon-cache'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import type { MentionItemType } from './mention-menu'

// ============================================================================
// 类型
// ============================================================================

/** 粘贴文本超过这个行数时，自动转为文件附件 */
const LONG_TEXT_LINE_THRESHOLD = 100

export interface EscapeCompositionEventLike {
  key?: string
  isComposing?: boolean
  nativeEvent?: {
    isComposing?: boolean
  }
}

/**
 * 判断是否在 IME 组合过程中按下了 Escape。
 *
 * 同时检查本地组合状态和事件层标志，以保证不同浏览器/运行时的兼容性。
 */
export function isEscapeDuringComposition(
  event: EscapeCompositionEventLike,
  isComposingRefActive: boolean
): boolean {
  if (event.key !== 'Escape') return false
  return Boolean(isComposingRefActive || event.isComposing || event.nativeEvent?.isComposing)
}

export interface RichTextInputProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'onInput' | 'onPaste'> {
  /** 当前文本值 */
  value: string
  /** 文本变化回调 */
  onChange: (value: string) => void
  /** 占位文本，可以是单字符串或字符串数组（轮播显示） */
  placeholder?: string | string[]
  /** 可用于 mention 解析的 Skill 列表 */
  skills?: LoadedSkill[]
  /** 可用于 mention 解析的 Source 列表 */
  sources?: LoadedSource[]
  /** Workspace ID，用于加载头像 */
  workspaceId?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 输入变化回调（提供值和光标位置，用于 mention 检测） */
  onInput?: (value: string, cursorPosition: number) => void
  /** 粘贴事件回调 */
  onPaste?: (e: React.ClipboardEvent) => void
  /** 粘贴内容超过行数阈值时触发，调用方应创建文件附件 */
  onLongTextPaste?: (text: string) => void
}

/**
 * RichTextInput 通过 forwardRef 暴露的 imperative handle。
 * 类似 Go 接口：父组件可以直接调用 focus、setValue 等方法。
 */
export interface RichTextInputHandle {
  focus: () => void
  blur: () => void
  /** 当前文本值 */
  value: string
  /** 文本模型中的选区起始位置 */
  selectionStart: number
  /** 设置文本值 */
  setValue: (value: string) => void
  /** 设置选区范围 */
  setSelectionRange: (start: number, end: number) => void
  /** 获取整个元素包围盒 */
  getBoundingClientRect: () => DOMRect
  /** 获取当前光标/选区位置的包围盒 */
  getCaretRect: () => DOMRect | null
  /** 底层 div 元素 */
  element: HTMLDivElement | null
}

// ============================================================================
// InlineMentionBadge — 内联 mention 徽章（静态 HTML 版本）
// ============================================================================

// SVG 图标用 HTML 字符串内联，避免在浏览器里使用 react-dom/server
const SKILL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`

const SOURCE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`

// 文件图标（带折角的文档），与 UserMessageBubble 风格一致
const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`

// 代码文件图标（文档 + <>），与 UserMessageBubble 风格一致
const CODE_FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`

// 文件夹图标（打开的文件夹），与 UserMessageBubble 风格一致
const FOLDER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/></svg>`

/** 已知的代码文件扩展名，用于选择代码文件图标或通用文件图标 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

function isCodeFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? CODE_EXTENSIONS.has(ext) : false
}

function renderBadgeHTML(
  type: MentionItemType,
  label: string,
  skill?: LoadedSkill,
  source?: LoadedSource,
  workspaceId?: string,
  tooltip?: string
): string {
  // 优先使用缓存图标
  let iconHtml = ''
  let cachedIconUrl: string | null = null

  if (type === 'skill' && skill && workspaceId) {
    cachedIconUrl = getSkillIconSync(workspaceId, skill.slug)
  } else if (type === 'source' && source && workspaceId) {
    cachedIconUrl = getSourceIconSync(workspaceId, source.config.slug)
  }

  if (cachedIconUrl) {
    // emoji 标记：直接渲染文本，不用 img
    if (cachedIconUrl.startsWith(EMOJI_ICON_PREFIX)) {
      const emoji = cachedIconUrl.slice(EMOJI_ICON_PREFIX.length)
      iconHtml = `<span class="h-[12px] w-[12px] flex items-center justify-center text-[10px] leading-none shrink-0">${emoji}</span>`
    } else {
      // data URL 或外部 URL 用 img 展示
      iconHtml = `<img src="${cachedIconUrl}" class="h-[12px] w-[12px] rounded-[2px] shrink-0" alt="" />`
    }
  } else {
    // 按类型回退到通用 SVG 图标
    if (type === 'skill') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SKILL_ICON_SVG}</span>`
    } else if (type === 'source') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SOURCE_ICON_SVG}</span>`
    } else if (type === 'file') {
      // 根据扩展名选代码文件图标或通用文件图标
      iconHtml = isCodeFile(label) ? CODE_FILE_ICON_SVG : FILE_ICON_SVG
    } else if (type === 'folder') {
      iconHtml = FOLDER_ICON_SVG
    }
  }

  const escapedLabel = label.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const titleAttr = tooltip ? ` title="${tooltip.replace(/"/g, '&quot;')}"` : ''

  // 有徽章时行高会增大（见组件中的 hasMentions）
  // 用 transform 向上微调，不影响布局流（即使在一行开头也有效）
  return `<span contenteditable="false" data-mention="true"${titleAttr} class="mention-badge inline-flex items-center gap-1 h-[22px] px-1.5 mx-1 rounded-[5px] bg-background shadow-minimal text-[12px] text-foreground select-none [&_*]:selection:bg-transparent selection:bg-transparent" style="vertical-align: middle; transform: translateY(-1px)">${iconHtml}<span class="truncate max-w-[200px]">${escapedLabel}</span></span>`
}

// ============================================================================
// 辅助函数：从 contenteditable 提取纯文本
// ============================================================================

function getTextFromElement(element: HTMLElement): string {
  let text = ''

  // isTopLevel=true 表示是 contenteditable 根元素的直接子节点
  function processNode(node: Node, isTopLevel: boolean = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      // 过滤零宽空格（用于 contenteditable 光标修正）
      text += (node.textContent || '').replace(/\u200B/g, '')
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // 跳过 mention 徽章本身，避免重复计入文本
      if (el.getAttribute('data-mention') === 'true') {
        // 从 data 属性取原始 mention 文本
        const mentionText = el.getAttribute('data-mention-text')
        if (mentionText) {
          text += mentionText
        }
        return // 不处理子节点
      }

      // 处理换行
      if (el.tagName === 'BR') {
        text += '\n'
      } else if (el.tagName === 'DIV' && text.length > 0 && !text.endsWith('\n')) {
        // contenteditable 里的 DIV 通常代表换行。
        // 但浏览器在徽章前输入字符时可能把字符包在 <div> 里：
        // <div>typed</div><span badge>
        // 这不是用户想要的换行，需要检测并跳过。
        if (isTopLevel) {
          // 检查该 DIV 后面是否紧跟顶层 mention 徽章，
          // 跳过中间可能存在的只含零宽空格的文本节点。
          let nextSibling: Node | null = el.nextSibling
          while (
            nextSibling?.nodeType === Node.TEXT_NODE &&
            nextSibling.textContent?.replace(/\u200B/g, '') === ''
          ) {
            nextSibling = nextSibling.nextSibling
          }
          const isBrowserWrapper =
            (nextSibling as HTMLElement)?.getAttribute?.('data-mention') === 'true'
          if (!isBrowserWrapper) {
            text += '\n'
          }
          // 如果确实紧跟徽章，则不额外加换行，只处理子节点
        } else {
          // 嵌套 DIV 始终视为换行
          text += '\n'
        }
      }

      // 递归处理子节点（不再视为顶层）
      Array.from(el.childNodes).forEach(child => {
        processNode(child, false)
      })
    }
  }

  // 根节点直接子节点按顶层处理
  Array.from(element.childNodes).forEach(child => {
    processNode(child, true)
  })

  return text
}

// ============================================================================
// 辅助函数：获取文本模型中的光标位置
// ============================================================================

function getCursorPosition(element: HTMLElement, fallback: number = 0): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return fallback

  const range = selection.getRangeAt(0)

  // 创建从元素开头到光标的 range
  const preRange = document.createRange()
  preRange.selectNodeContents(element)
  preRange.setEnd(range.startContainer, range.startOffset)

  // 计算光标前的文本长度，排除 badge 内容
  const fragment = preRange.cloneContents()
  const div = document.createElement('div')
  div.appendChild(fragment)
  return getTextFromElement(div).length
}

// ============================================================================
// 辅助函数：在 contenteditable 中设置光标位置
// ============================================================================

function setCursorPosition(element: HTMLElement, targetPosition: number): void {
  const selection = window.getSelection()
  if (!selection) return

  let currentPos = 0

  function findPosition(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent || ''
      // 过滤零宽空格以匹配文本模型（ZWS 只是 DOM 产物）
      const textWithoutZWS = rawText.replace(/\u200B/g, '')
      const modelLength = textWithoutZWS.length

      if (currentPos + modelLength >= targetPosition) {
        // 考虑零宽空格后计算实际 DOM offset
        const modelOffset = targetPosition - currentPos
        let domOffset = 0
        let modelCount = 0
        while (modelCount < modelOffset && domOffset < rawText.length) {
          if (rawText[domOffset] !== '\u200B') {
            modelCount++
          }
          domOffset++
        }
        // 跳过目标位置后面的零宽空格
        while (domOffset < rawText.length && rawText[domOffset] === '\u200B') {
          domOffset++
        }
        return { node, offset: domOffset }
      }
      currentPos += modelLength
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // mention 徽章整体视为原子节点，不进入内部
      if (el.getAttribute('data-mention') === 'true') {
        const mentionText = el.getAttribute('data-mention-text') || ''
        const mentionLength = mentionText.length
        if (currentPos + mentionLength >= targetPosition) {
          // 光标放在徽章后面
          return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 }
        }
        currentPos += mentionLength
        return null
      }

      // 处理 BR 换行
      if (el.tagName === 'BR') {
        currentPos += 1
        if (currentPos >= targetPosition) {
          return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 }
        }
        return null
      }

      for (let i = 0; i < el.childNodes.length; i++) {
        const result = findPosition(el.childNodes[i])
        if (result) return result
      }
    }
    return null
  }

  const result = findPosition(element)

  if (result) {
    const range = document.createRange()
    range.setStart(result.node, result.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  } else {
    //  fallback：定位到末尾
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
}

// ============================================================================
// 把带 mention 的文本转换为 HTML
// ============================================================================

function textToHTML(
  text: string,
  skills: LoadedSkill[],
  sources: LoadedSource[],
  workspaceId?: string
): string {
  if (!text) return ''

  const skillSlugs = skills.map(s => s.slug)
  const sourceSlugs = sources.map(s => s.config.slug)
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)

  // HTML 转义
  const escapeHTML = (str: string) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

  if (matches.length === 0) {
    return escapeHTML(text)
  }

  let html = ''
  let lastIndex = 0

  // 如果第一个 mention 在位置 0，前面补一个零宽空格，解决 contenteditable 开头光标问题
  if (matches[0].startIndex === 0) {
    html += '\u200B'
  }

  for (const match of matches) {
    // 加入 mention 之前的转义文本
    if (match.startIndex > lastIndex) {
      html += escapeHTML(text.slice(lastIndex, match.startIndex))
    }

    // 确定徽章显示文本和关联数据
    let label = match.id
    let skill: LoadedSkill | undefined
    let source: LoadedSource | undefined
    let tooltip: string | undefined

    if (match.type === 'skill') {
      skill = skills.find(s => s.slug === match.id)
      label = skill?.metadata.name || match.id
    } else if (match.type === 'source') {
      source = sources.find(s => s.config.slug === match.id)
      label = source?.config.name || match.id
    } else if (match.type === 'file') {
      // 文件名做徽章标签，完整路径做 tooltip
      label = match.id.split('/').pop() || match.id
      tooltip = match.id
    } else if (match.type === 'folder') {
      // 文件夹名做徽章标签，完整路径做 tooltip
      label = match.id.split('/').pop() || match.id
      tooltip = match.id
    }

    // 渲染徽章，并用 data-mention-text 保存原始文本，方便提取时还原
    const badgeHtml = renderBadgeHTML(match.type, label, skill, source, workspaceId, tooltip)
    const withMentionText = badgeHtml.replace(
      'data-mention="true"',
      `data-mention="true" data-mention-text="${match.fullMatch.replace(/"/g, '&quot;')}"`
    )
    html += withMentionText
    // 徽章后面加零宽空格，确保最后一个徽章后也能放光标
    html += '\u200B'

    lastIndex = match.startIndex + match.fullMatch.length
  }

  // 加入最后一个 mention 之后的剩余文本
  if (lastIndex < text.length) {
    html += escapeHTML(text.slice(lastIndex))
  }

  return html
}

// ============================================================================
// 判断 mention 是否发生变化（决定是否要重新渲染 HTML）
// ============================================================================

function getMentionSignature(text: string, skillSlugs: string[], sourceSlugs: string[]): string {
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)
  return matches.map(m => `${m.type}:${m.id}:${m.startIndex}`).join('|')
}

// ============================================================================
// RotatingPlaceholder — 轮播占位提示
// 用淡入淡出切换一组提示文本，输入框聚焦时仍然显示，直到用户输入。
// ============================================================================

interface RotatingPlaceholderProps {
  /** 轮播的占位文本数组 */
  placeholders: string[]
  /** 每次切换间隔，单位毫秒（默认 5000） */
  intervalMs?: number
  /** 额外 className */
  className?: string
}

function RotatingPlaceholder({
  placeholders,
  intervalMs = 5000,
  className,
}: RotatingPlaceholderProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0)
  const [opacity, setOpacity] = React.useState(1)

  React.useEffect(() => {
    // 只有一个占位文本时不轮播
    if (placeholders.length <= 1) return

    const interval = setInterval(() => {
      // 淡出
      setOpacity(0)

      // 300ms 淡出后切换文本并淡入
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % placeholders.length)
        setOpacity(1)
      }, 300)
    }, intervalMs)

    return () => clearInterval(interval)
  }, [placeholders.length, intervalMs])

  return (
    <div
      className={cn('transition-opacity duration-300 ease-in-out', className)}
      style={{ opacity }}
    >
      {placeholders[currentIndex]}
    </div>
  )
}

// ============================================================================
// RichTextInput 组件
// ============================================================================

/** 支持 mention 的富文本输入框 */
export const RichTextInput = React.forwardRef<RichTextInputHandle, RichTextInputProps>(
  function RichTextInput(
    {
      value,
      onChange,
      placeholder,
      skills = [],
      sources = [],
      workspaceId,
      disabled = false,
      className,
      onFocus,
      onBlur,
      onKeyDown,
      onInput,
      onPaste,
      onLongTextPaste,
      ...restProps
    },
    forwardedRef
  ) {
    const { t } = useTranslation()
    const safeValue = React.useMemo(() => coerceInputText(value), [value])
    const divRef = React.useRef<HTMLDivElement>(null)
    const [isFocused, setIsFocused] = React.useState(false)
    const isComposing = React.useRef(false)
    const lastValueRef = React.useRef(safeValue)
    const cursorPositionRef = React.useRef(0)
    const lastMentionSignatureRef = React.useRef('')
    const isInternalUpdate = React.useRef(false)
    // 外部更新 value 后需要恢复的光标位置（例如选择了 @mention 之后）
    const pendingCursorRef = React.useRef<number | null>(null)

    const skillSlugs = React.useMemo(() => skills.map(s => s.slug), [skills])
    const sourceSlugs = React.useMemo(() => sources.map(s => s.config.slug), [sources])

    // 预加载 source 和 skill 的图标
    React.useEffect(() => {
      if (!workspaceId) return

      for (const source of sources) {
        loadSourceIcon({ config: source.config, workspaceId })
      }

      // 预加载 skill 图标，支持 emoji、URL、本地文件和自动发现
      for (const skill of skills) {
        loadSkillIcon(skill, workspaceId)
      }
    }, [sources, skills, workspaceId])

    // 通过 imperative handle 暴露方法给父组件
    React.useImperativeHandle(forwardedRef, () => ({
      focus: () => divRef.current?.focus(),
      blur: () => divRef.current?.blur(),
      get value() { return lastValueRef.current },
      get selectionStart() { return cursorPositionRef.current },
      setValue: (newValue: string) => {
        lastValueRef.current = newValue
      },
      setSelectionRange: (start: number, _end: number) => {
        // 先暂存光标位置，等外部 value 同步进来后再恢复
        pendingCursorRef.current = start
        cursorPositionRef.current = start
        if (divRef.current) {
          setCursorPosition(divRef.current, start)
        }
      },
      getBoundingClientRect: () => divRef.current?.getBoundingClientRect() ?? new DOMRect(),
      getCaretRect: () => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return null
        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        // 如果 rect 是零尺寸（行首折叠选区），用临时 span 测量
        if (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) {
          const span = document.createElement('span')
          span.textContent = '\u200B'
          range.insertNode(span)
          const spanRect = span.getBoundingClientRect()
          span.remove()
          // 恢复选区
          selection.removeAllRanges()
          selection.addRange(range)
          return spanRect
        }
        return rect
      },
      get element() { return divRef.current },
    }), [])

    // 处理输入事件
    const handleInput = React.useCallback(() => {
      if (isComposing.current) return
      if (!divRef.current) return

      const newText = getTextFromElement(divRef.current)
      const cursorPos = getCursorPosition(divRef.current, cursorPositionRef.current)

      lastValueRef.current = newText
      cursorPositionRef.current = cursorPos

      // mention 变化时重新渲染 HTML 徽章
      const newSignature = getMentionSignature(newText, skillSlugs, sourceSlugs)
      if (newSignature !== lastMentionSignatureRef.current) {
        lastMentionSignatureRef.current = newSignature
        isInternalUpdate.current = true
        const html = textToHTML(newText, skills, sources, workspaceId)
        divRef.current.innerHTML = html || '<br>' // 空 contenteditable 需要保留一个 BR
        setCursorPosition(divRef.current, cursorPos)
        isInternalUpdate.current = false
      }

      onChange(newText)
      onInput?.(newText, cursorPos)
    }, [onChange, onInput, skills, sources, skillSlugs, sourceSlugs, workspaceId])

    // 处理 IME 组合输入
    const handleCompositionStart = React.useCallback(() => {
      isComposing.current = true
    }, [])

    const handleCompositionEnd = React.useCallback(() => {
      isComposing.current = false
      handleInput()
    }, [handleInput])

    const handleKeyDownInternal = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEscapeDuringComposition(e, isComposing.current)) {
        e.stopPropagation()
        return
      }

      onKeyDown?.(e)
    }, [onKeyDown])

    // 粘贴处理：文件交给父组件，纯文本手动插入
    const handlePasteInternal = React.useCallback((e: React.ClipboardEvent) => {
      // 如果有文件，交给父组件处理
      const hasFiles = e.clipboardData?.files && e.clipboardData.files.length > 0
      if (hasFiles && onPaste) {
        e.preventDefault()
        onPaste(e)
        return
      }

      // 阻止默认粘贴，避免贴入 HTML，然后手动插入纯文本
      e.preventDefault()

      const text = e.clipboardData?.getData('text/plain')
      if (!text) return

      // 文本过长时转为文件附件
      const lineCount = text.split('\n').length
      if (lineCount > LONG_TEXT_LINE_THRESHOLD && onLongTextPaste) {
        onLongTextPaste(text)
        return
      }

      // 用 execCommand 插入文本，能纳入浏览器原生撤销栈，Cmd+Z 有效。
      // 手动 range.insertNode 会绕过撤销历史。
      document.execCommand('insertText', false, text)
    }, [onPaste, onLongTextPaste])

    // 聚焦处理
    const handleFocus = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
      setIsFocused(true)
      // 让浏览器用 <br> 而不是 <div> 作为换行符，
      // 避免在不可编辑徽章前输入时被浏览器包一层 div。
      document.execCommand('defaultParagraphSeparator', false, 'br')
      onFocus?.(e)
    }, [onFocus])

    // 失焦处理
    const handleBlur = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
      setIsFocused(false)
      onBlur?.(e)
    }, [onBlur])

    // 从 props 同步 value（父组件外部更新时）
    React.useEffect(() => {
      if (!divRef.current) return
      if (isInternalUpdate.current) return
      if (lastValueRef.current === safeValue) return

      lastValueRef.current = safeValue
      lastMentionSignatureRef.current = getMentionSignature(safeValue, skillSlugs, sourceSlugs)

      const html = textToHTML(safeValue, skills, sources, workspaceId)
      divRef.current.innerHTML = html || '<br>'

      // 更新 innerHTML 后恢复光标位置。只在以下情况恢复：
      // 1. setSelectionRange 显式指定了 pending 位置；
      // 2. 输入框当前聚焦（用户正在编辑）。
      // 这样切换 Session 时不会抢走搜索框焦点。
      if (pendingCursorRef.current !== null || document.activeElement === divRef.current) {
        const cursorPos = pendingCursorRef.current ?? cursorPositionRef.current ?? safeValue.length
        setCursorPosition(divRef.current, cursorPos)
        pendingCursorRef.current = null
      }
    }, [safeValue, skills, sources, skillSlugs, sourceSlugs, workspaceId])

    // 挂载时初始化内容
    React.useEffect(() => {
      if (!divRef.current) return
      lastMentionSignatureRef.current = getMentionSignature(safeValue, skillSlugs, sourceSlugs)
      const html = textToHTML(safeValue, skills, sources, workspaceId)
      divRef.current.innerHTML = html || '<br>'
      lastValueRef.current = safeValue
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // 选区变化时高亮被选中的 mention 徽章
    React.useEffect(() => {
      // 从 CSS 变量取强调色并加透明度
      const getSelectionColor = () => {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
        return accent ? `oklch(${accent.replace('oklch(', '').replace(')', '')} / 0.4)` : 'rgba(99, 102, 241, 0.4)'
      }

      const handleSelectionChange = () => {
        if (!divRef.current) return

        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return

        const range = selection.getRangeAt(0)

        // 获取所有 mention 徽章
        const badges = divRef.current.querySelectorAll('.mention-badge') as NodeListOf<HTMLElement>

        badges.forEach((badge) => {
          // 判断徽章是否在选区范围内
          const badgeRange = document.createRange()
          badgeRange.selectNode(badge)

          const isSelected =
            range.compareBoundaryPoints(Range.START_TO_END, badgeRange) > 0 &&
            range.compareBoundaryPoints(Range.END_TO_START, badgeRange) < 0

          if (isSelected) {
            badge.style.backgroundColor = getSelectionColor()
            badge.classList.remove('bg-background')
          } else {
            badge.style.backgroundColor = ''
            badge.classList.add('bg-background')
          }
        })
      }

      document.addEventListener('selectionchange', handleSelectionChange)
      return () => document.removeEventListener('selectionchange', handleSelectionChange)
    }, [])

    // 输入为空时显示占位提示（无论是否聚焦）
    const showPlaceholder = !safeValue

    // 把占位文本统一成数组传给 RotatingPlaceholder
    const placeholderArray = React.useMemo(() => {
      if (!placeholder) return [t("chatInput.placeholder.typeMessage")]
      return Array.isArray(placeholder) ? placeholder : [placeholder]
    }, [placeholder])

    // 是否包含 mention（用于调整行高）
    const hasMentions = React.useMemo(() => {
      const mentions = parseMentions(safeValue, skillSlugs, sourceSlugs)
      return mentions.skills.length > 0 || mentions.sources.length > 0 || mentions.files.length > 0 || mentions.folders.length > 0
    }, [safeValue, skillSlugs, sourceSlugs])

    return (
      <div className="relative">
        <div
          ref={divRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          tabIndex={disabled ? -1 : 0}
          className={cn(
            'outline-none text-sm whitespace-pre-wrap break-words',
            'min-h-[1.5em]',
            disabled && 'opacity-50 cursor-not-allowed',
            // 显示占位文本时把文字设为透明，但保留光标
            showPlaceholder && 'text-transparent caret-foreground',
            className
          )}
          // 用行内样式覆盖 text-sm 的默认行高
          style={{ lineHeight: 1.25 }}
          onInput={handleInput}
          onKeyDown={handleKeyDownInternal}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPaste={handlePasteInternal}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          aria-disabled={disabled}
          aria-placeholder={Array.isArray(placeholder) ? placeholder[0] : placeholder}
          role="textbox"
          aria-multiline="true"
          {...restProps}
        />
        {/* 轮播占位文本覆盖层：为空时显示，聚焦时也显示 */}
        {showPlaceholder && (
          <RotatingPlaceholder
            placeholders={placeholderArray}
            intervalMs={5000}
            className={cn(
              'absolute inset-0 text-sm text-muted-foreground pointer-events-none select-none',
              className
            )}
          />
        )}
      </div>
    )
  }
)
