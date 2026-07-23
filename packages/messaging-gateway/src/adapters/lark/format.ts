/**
 * format.ts — Markdown → Lark `post` 转换器。
 *
 * Lark/飞书的 `post` 富文本类型是一个结构化 JSON 格式，支持一部分格式
 * （粗体、斜体、删除线、链接、代码块）。标题、列表、表格没有原生对应——
 * 这些会以纯文本形式落入 `text` 元素。
 *
 * 当输入没有任何格式提示时返回 `{ kind: 'text', text }`，让适配器改用更轻量的
 * `text` 消息类型；否则返回 `{ kind: 'post', post }`。
 *
 * 解析器只处理上述行内子集。嵌套样式（斜体里套粗体）通过状态机实现；
 * 更深的嵌套和生僻的 Markdown 边界情况有意不做支持——把范围收窄可以缩小
 * 富 Markdown 转换器常见的 bug 面。
 */

export type LarkPostStyle = 'bold' | 'italic' | 'underline' | 'strikethrough'

export type LarkPostElement =
  | { tag: 'text'; text: string; style?: LarkPostStyle[] }
  | { tag: 'a'; text: string; href: string; style?: LarkPostStyle[] }
  | { tag: 'code_block'; language?: string; text: string }

export interface LarkPost {
  post: {
    en_us: {
      content: LarkPostElement[][]
    }
  }
}

export type LarkFormatted =
  | { kind: 'text'; text: string }
  | { kind: 'post'; post: LarkPost }

/**
 * 把 agent 的 Markdown 输出转换为 Lark 线上报文。
 *
 * 覆盖范围：
 *   - `**bold**`              → 带 `style: ['bold']` 的 `text`
 *   - `*italic*` / `_italic_` → 带 `style: ['italic']` 的 `text`
 *   - `~~strike~~`            → 带 `style: ['strikethrough']` 的 `text`
 *   - `[label](url)`          → `a` 元素
 *   - ` ```lang\ncode``` `    → `code_block` 元素
 *   - `` `inline` ``          → 带 `style: ['bold']` 的 `text`（Lark 没有
 *                              inline-code 元素；粗体是最接近的视觉提示）
 *   - `\n\n`                  → 新的顶层段落条目
 *   - `\n`（段落内）         → 由 Lark 的自动换行处理
 *
 * 不支持（按字面文本渲染）：标题、列表、表格、图片。
 */
export function formatForLarkPost(markdown: string): LarkFormatted {
  const trimmed = markdown.replace(/\r\n/g, '\n')
  const paragraphs = splitParagraphs(trimmed)

  const content: LarkPostElement[][] = []
  let anyStyled = false

  for (const para of paragraphs) {
    const codeMatch = matchCodeBlock(para)
    if (codeMatch) {
      content.push([
        codeMatch.language
          ? { tag: 'code_block', language: codeMatch.language, text: codeMatch.text }
          : { tag: 'code_block', text: codeMatch.text },
      ])
      anyStyled = true
      continue
    }

    const elements = parseInline(para)
    if (elements.some((el) => isStyled(el))) anyStyled = true
    content.push(elements)
  }

  // 任何地方都没有带样式的元素 → 走纯文本路径。
  // 没必要从 elements 重新拼接；原始输入就是纯文本。
  if (!anyStyled) {
    return { kind: 'text', text: trimmed }
  }

  return {
    kind: 'post',
    post: { post: { en_us: { content } } },
  }
}

/**
 * 把任意文本包装成一个最简 post 消息。当原发送是 `post`、而编辑内容是纯文本时，
 * `editMessage` 会用到它——Lark 要求新的 `msg_type` 与原消息一致。
 */
export function wrapAsTrivialPost(text: string): LarkPost {
  return {
    post: {
      en_us: {
        content: [[{ tag: 'text', text }]],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function splitParagraphs(input: string): string[] {
  // 段落分隔 = 两个或更多换行。每段去掉尾部空白，但保留段内的单个换行
  //（Lark 会在 `text` 内自动换行）。
  const raw = input.split(/\n{2,}/)
  return raw.map((p) => p.trimEnd()).filter((p) => p.length > 0)
}

function matchCodeBlock(para: string): { language: string | undefined; text: string } | null {
  // 匹配整段就是一个围栏代码块的情况：以 ``` 开头，可选语言，内容直到闭合 ```。
  // 只有当围栏框住整段内容时，才把整段当作代码块。
  const m = para.match(/^```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```$/)
  if (!m) return null
  const lang = m[1]?.trim() || undefined
  return { language: lang, text: m[2] ?? '' }
}

function isStyled(el: LarkPostElement): boolean {
  if (el.tag === 'code_block') return true
  if (el.tag === 'a') return true
  if (el.tag === 'text' && el.style && el.style.length > 0) return true
  return false
}

interface InlineToken {
  type: 'text' | 'open' | 'close' | 'link'
  /** 对 `text`：字面字符。对 `open`/`close`：样式。对 `link`：文本。 */
  value: string
  /** 仅 `link` token 有。 */
  href?: string
  /** 仅 `open`/`close` token 有。 */
  style?: LarkPostStyle
}

/**
 * 对一个行内片段做分词，再拼装成 Lark 的 `text`/`a` 元素。
 *
 * 算法：扫描字符串，识别格式标记（`**`、`*`、`_`、`~~`、反引号、`[label](url)`），
 * 构建一个 token 列表，然后用样式栈遍历 token 生成元素。
 * 转义字符（`\*` 等）作为字面文本保留。
 */
function parseInline(input: string): LarkPostElement[] {
  const tokens = tokenizeInline(input)
  const elements: LarkPostElement[] = []
  const styleStack: LarkPostStyle[] = []

  const pushText = (text: string) => {
    if (text.length === 0) return
    const styles = [...styleStack]
    if (styles.length > 0) {
      elements.push({ tag: 'text', text, style: dedupeStyles(styles) })
    } else {
      elements.push({ tag: 'text', text })
    }
  }

  for (const tok of tokens) {
    if (tok.type === 'text') {
      pushText(tok.value)
    } else if (tok.type === 'open' && tok.style) {
      styleStack.push(tok.style)
    } else if (tok.type === 'close' && tok.style) {
      // 弹出最近的匹配样式。如果栈状态不一致（close 没有对应 open），
      // 当作字面文本处理——优雅降级。
      const idx = styleStack.lastIndexOf(tok.style)
      if (idx >= 0) styleStack.splice(idx, 1)
      else pushText(tok.value)
    } else if (tok.type === 'link' && tok.href) {
      const styles = [...styleStack]
      if (styles.length > 0) {
        elements.push({ tag: 'a', text: tok.value, href: tok.href, style: dedupeStyles(styles) })
      } else {
        elements.push({ tag: 'a', text: tok.value, href: tok.href })
      }
    }
  }

  return mergeAdjacentText(elements)
}

function dedupeStyles(styles: LarkPostStyle[]): LarkPostStyle[] {
  return Array.from(new Set(styles))
}

function mergeAdjacentText(elements: LarkPostElement[]): LarkPostElement[] {
  if (elements.length === 0) return [{ tag: 'text', text: '' }]
  const out: LarkPostElement[] = []
  for (const el of elements) {
    const prev = out[out.length - 1]
    if (
      el.tag === 'text' &&
      prev &&
      prev.tag === 'text' &&
      sameStyle(prev.style, el.style)
    ) {
      prev.text += el.text
    } else {
      out.push(el)
    }
  }
  return out
}

function sameStyle(a?: LarkPostStyle[], b?: LarkPostStyle[]): boolean {
  const aArr = a ?? []
  const bArr = b ?? []
  if (aArr.length !== bArr.length) return false
  return aArr.every((s) => bArr.includes(s))
}

function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let buf = ''
  const flushBuf = () => {
    if (buf.length > 0) {
      tokens.push({ type: 'text', value: buf })
      buf = ''
    }
  }

  // 跟踪当前有哪些行内样式处于开启状态，以判断下一个标记应当开启还是闭合。
  const openStyles = new Set<LarkPostStyle>()

  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    const next2 = input[i + 2]

    // 转义：把下一个字符当字面量保留
    if (ch === '\\' && next) {
      buf += next
      i += 2
      continue
    }

    // 链接：[label](url) —— label 非贪婪，括号里可能含 query string
    if (ch === '[') {
      const linkMatch = input.slice(i).match(/^\[([^\]]+)\]\((https?:[^)\s]+)\)/)
      if (linkMatch) {
        flushBuf()
        tokens.push({ type: 'link', value: linkMatch[1]!, href: linkMatch[2]! })
        i += linkMatch[0].length
        continue
      }
    }

    // 粗体（**）——消耗两个标记
    if (ch === '*' && next === '*') {
      flushBuf()
      const open = !openStyles.has('bold')
      tokens.push({ type: open ? 'open' : 'close', value: '**', style: 'bold' })
      if (open) openStyles.add('bold')
      else openStyles.delete('bold')
      i += 2
      continue
    }

    // 斜体 —— `*single*` 或 `_single_`。标准 Markdown 规则：
    //   - 开启标记：下一个字符必须非空白
    //   - 闭合标记：上一个字符必须非空白
    // 我们用单个开启标志跟踪斜体（不对混用的 `*`/`_` 做标记配对），
    // 因为 Lark `post` 不区分二者。
    if ((ch === '*' || ch === '_') && next !== ch) {
      if (openStyles.has('italic')) {
        // 闭合情形 —— 上一个字符必须非空白。
        const prevChar = buf.length > 0 ? buf[buf.length - 1] : input[i - 1]
        if (prevChar && prevChar !== ' ' && prevChar !== '\n') {
          flushBuf()
          tokens.push({ type: 'close', value: ch, style: 'italic' })
          openStyles.delete('italic')
          i += 1
          continue
        }
      } else if (next && next !== ' ' && next !== '\n') {
        // 开启情形 —— 后面必须有对应的闭合标记。
        const closeIdx = findClosingMarker(input, i + 1, ch)
        if (closeIdx > 0) {
          flushBuf()
          tokens.push({ type: 'open', value: ch, style: 'italic' })
          openStyles.add('italic')
          i += 1
          continue
        }
      }
    }

    // 删除线（~~）
    if (ch === '~' && next === '~') {
      flushBuf()
      const open = !openStyles.has('strikethrough')
      tokens.push({ type: open ? 'open' : 'close', value: '~~', style: 'strikethrough' })
      if (open) openStyles.add('strikethrough')
      else openStyles.delete('strikethrough')
      i += 2
      continue
    }

    // 行内代码 —— 反引号界定；按文档约定的回退映射为粗体
    if (ch === '`' && next !== '`') {
      const closeIdx = input.indexOf('`', i + 1)
      if (closeIdx > i) {
        flushBuf()
        tokens.push({ type: 'open', value: '`', style: 'bold' })
        tokens.push({ type: 'text', value: input.slice(i + 1, closeIdx) })
        tokens.push({ type: 'close', value: '`', style: 'bold' })
        i = closeIdx + 1
        continue
      }
    }

    // 抑制 lookahead 变量的未使用告警
    void next2

    buf += ch
    i += 1
  }

  flushBuf()
  return tokens
}

/**
 * 找到下一个合法闭合位置的单字符标记（`*` 或 `_`）的索引。
 * 合法闭合位置 = 标记前一个字符非空格，且标记后面没有紧跟同类标记。
 */
function findClosingMarker(input: string, from: number, marker: string): number {
  for (let j = from; j < input.length; j++) {
    if (input[j] !== marker) continue
    if (input[j + 1] === marker) continue
    const prev = input[j - 1]
    if (prev === ' ' || prev === '\n') continue
    return j
  }
  return -1
}
