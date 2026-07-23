import * as React from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { cn } from '../../lib/utils'
import { CodeBlock, InlineCode } from './CodeBlock'
import { MarkdownDiffBlock } from './MarkdownDiffBlock'
import { MarkdownJsonBlock } from './MarkdownJsonBlock'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'
import { MarkdownDatatableBlock } from './MarkdownDatatableBlock'
import { MarkdownSpreadsheetBlock } from './MarkdownSpreadsheetBlock'
import { MarkdownHtmlBlock } from './MarkdownHtmlBlock'
import { MarkdownImageBlock } from './MarkdownImageBlock'
import { MarkdownLatexBlock } from './MarkdownLatexBlock'
import { MarkdownPdfBlock } from './MarkdownPdfBlock'
import { MarkdownDocBlock } from './MarkdownDocBlock'
import { preprocessLinks } from './linkify'
import { resolveMarkdownLinkTarget } from './link-target'
import remarkCollapsibleSections from './remarkCollapsibleSections'
import { CollapsibleSection } from './CollapsibleSection'
import { useCollapsibleMarkdown } from './CollapsibleMarkdownContext'
import { wrapWithSafeProxy } from './safe-components'
import { MARKDOWN_MATH_OPTIONS } from './math-options'
import { markdownUrlTransform } from './url-transform'

/**
 * 递归调用 `Markdown` 时可能需要抑制的 preview-block 代码围栏类型名。
 * 供 `MarkdownDocBlock` 使用,用于避免 `markdown-preview` 自递归,
 * 同时保留其他 preview block(mermaid、datatable 等)正常工作。
 */
export type DisablablePreviewBlock =
  | 'markdown-preview'
  | 'html-preview'
  | 'pdf-preview'
  | 'image-preview'

/**
 * markdown 内容的渲染模式:
 *
 * - 'terminal':原始输出、最少格式化,控制字符可见
 *   最适合:调试输出、原始日志、想精确看到实际内容的场景
 *
 * - 'minimal':带语法高亮的简洁渲染,无额外装饰
 *   最适合:聊天消息、内嵌内容、追求可读性而不希望有杂乱装饰的场景
 *
 * - 'full':富渲染,带美观的表格、带样式的代码块、规范的排版
 *   最适合:文档、长文内容、注重展示效果的场景
 */
export type RenderMode = 'terminal' | 'minimal' | 'full'

export interface MarkdownProps {
  children: string
  /**
   * 控制格式化级别的渲染模式
   * @default 'minimal'
   */
  mode?: RenderMode
  className?: string
  /**
   * 用于 memoization 的消息 ID(可选)
   * 提供后会对解析结果做 memo,避免流式过程中重复解析
   */
  id?: string
  /**
   * 点击 URL 时的回调
   */
  onUrlClick?: (url: string) => void
  /**
   * 点击文件路径时的回调
   */
  onFileClick?: (path: string) => void
  /**
   * 启用可折叠标题
   * 需要外层用 CollapsibleMarkdownProvider 包裹
   * @default false
   */
  collapsible?: boolean
  /**
   * 隐藏首个 mermaid block 的展开按钮(当消息以 mermaid 开头时)
   * 在聊天场景中用于避免与 TurnCard 的全屏按钮重叠
   * @default true
   */
  hideFirstMermaidExpand?: boolean
  /**
   * 针对嵌套渲染禁用特定的 preview-block 处理器。
   *
   * 当某个 preview-block 组件再次通过 `Markdown` 渲染用户提供的 markdown
   * 时(例如 `MarkdownDocBlock`),可以传入想要抑制的 preview-block 类型名,
   * 以防止无限递归。被抑制的 block 会回退到默认的 `CodeBlock` 渲染器。
   *
   * 默认行为(不传该 prop):所有 preview block 均注册。
   */
  disablePreviewBlocks?: ReadonlySet<DisablablePreviewBlock>
}

/** 可折叠 section 的 context */
interface CollapsibleContext {
  collapsedSections: Set<string>
  toggleSection: (id: string) => void
}

/**
 * 根据渲染模式创建自定义组件。
 *
 * @param firstMermaidCodeRef - 当 markdown 消息以 mermaid 围栏开头时,保存
 *   第一个 mermaid block 代码的 ref。用于隐藏该 block 内联的展开按钮
 *   (TurnCard 自己的全屏按钮占据了同一个右上角位置)。使用 ref 的目的是
 *   让闭包能读取最新值,而无需把内容加入 memo 依赖 —— 否则每次流式更新
 *   都会导致组件重新挂载。
 * @param hideFirstMermaidExpand - 当消息以 mermaid 围栏开头时,是否隐藏首个
 *   mermaid block 的展开按钮。默认为 true。
 */
function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function createComponents(
  mode: RenderMode,
  onUrlClick?: (url: string) => void,
  onFileClick?: (path: string) => void,
  collapsibleContext?: CollapsibleContext | null,
  firstMermaidCodeRef?: React.RefObject<string | null>,
  hideFirstMermaidExpand: boolean = true,
  disablePreviewBlocks?: ReadonlySet<DisablablePreviewBlock>,
): Partial<Components> {
  const isPreviewEnabled = (name: DisablablePreviewBlock) => !disablePreviewBlocks?.has(name)
  let blockIndex = 0
  const wrapBlock = (
    blockType: string,
    content: string,
    child: React.ReactNode,
    nodePosition?: { start?: { line?: number }; end?: { line?: number } },
  ) => {
    blockIndex += 1
    const startLine = nodePosition?.start?.line
    const endLine = nodePosition?.end?.line
    const path = startLine && endLine
      ? `line:${startLine}-${endLine}`
      : `idx:${blockIndex}`
    const blockId = `blk-${stableHash(`${blockType}|${path}|${content.slice(0, 240)}`)}`

    return (
      <div
        data-ca-block-type={blockType}
        data-ca-block-path={path}
        data-ca-block-id={blockId}
      >
        {child}
      </div>
    )
  }

  const baseComponents: Partial<Components> = {
    // 可折叠标题的 section 包裹器
    div: ({ node, children, ...props }) => {
      const sectionId = (props as Record<string, unknown>)['data-section-id'] as string | undefined
      const headingLevel = (props as Record<string, unknown>)['data-heading-level'] as number | undefined

      // 若这是一个可折叠 section 的 div,且我们持有 context
      if (sectionId && headingLevel && collapsibleContext) {
        return (
          <CollapsibleSection
            sectionId={sectionId}
            headingLevel={headingLevel}
            isCollapsed={collapsibleContext.collapsedSections.has(sectionId)}
            onToggle={collapsibleContext.toggleSection}
          >
            {children}
          </CollapsibleSection>
        )
      }

      // 普通 div
      return <div {...props}>{children}</div>
    },
    // 链接:使其可点击并触发回调。
    //
    // 我们对 DOM `href` 的清理与点击分发目标是分开处理的:
    // - `safeHref` 是 React 放到 `<a>` 元素上的值。我们把 `href` 传给
    //   `defaultUrlTransform`;任何危险协议
    //   (javascript:/data:/vbscript:/file:) 会被置空,此时我们直接省略该属性。
    //   这样可以堵住中键点击和 cmd-click 的旁路(Electron 的
    //   `setWindowOpenHandler` / `will-navigate` 否则会绕过我们的 React
    //   `onClick`,直接调用 `shell.openExternal`)。
    // - 点击处理器仍然拿到原始 `href`,并通过 `resolveMarkdownLinkTarget`
    //   进行路由,使文件 URL 走 `onFileClick`,被阻止的 URL 通过
    //   `onUrlClick` → `classifyExternalUrl` 给出有意义的错误提示。
    a: ({ href, children }) => {
      const trimmedHref = href?.trim() ?? ''
      const sanitized = trimmedHref ? defaultUrlTransform(trimmedHref) : ''
      const safeHref = sanitized ? sanitized : undefined

      const handleClick = (e: React.MouseEvent) => {
        e.preventDefault()

        // 部分 AI 输出会包含原始 HTML 锚点,href 为空但文本内容是路径。
        // 当 href 缺失/为空时,回退到锚点文本。
        const fallbackText = React.Children.toArray(children)
          .map((child) => (typeof child === 'string' ? child : ''))
          .join('')
          .trim()

        const target = trimmedHref || fallbackText
        if (!target) return

        const resolvedTarget = resolveMarkdownLinkTarget(target)
        if (resolvedTarget.kind === 'file' && onFileClick) {
          onFileClick(resolvedTarget.path)
        } else if (resolvedTarget.kind === 'url' && onUrlClick) {
          onUrlClick(resolvedTarget.url)
        }
      }

      return (
        <a
          href={safeHref}
          onClick={handleClick}
          className="text-accent hover:underline cursor-pointer"
        >
          {children}
        </a>
      )
    },
  }

  // terminal 模式:最少格式化
  if (mode === 'terminal') {
    return {
      ...baseComponents,
      // 无特殊代码处理 - 仅等宽字体
      code: ({ children }) => (
        <code className="font-mono">{children}</code>
      ),
      pre: ({ children }) => (
        <pre className="font-mono whitespace-pre-wrap my-2">{children}</pre>
      ),
      // 较小的段落间距
      p: ({ children }) => <p className="my-1">{children}</p>,
      // 简单列表
      ul: ({ children }) => <ul className="list-disc list-inside my-1">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal list-inside my-1">{children}</ol>,
      li: ({ children }) => <li className="my-0.5">{children}</li>,
      // 纯文本表格
      table: ({ children }) => (
        <table className="my-2 font-mono text-sm">{children}</table>
      ),
      th: ({ children }) => <th className="text-left pr-4">{children}</th>,
      td: ({ children }) => <td className="pr-4">{children}</td>,
    }
  }

  // minimal 模式:简洁风格,带语法高亮
  if (mode === 'minimal') {
    return {
      ...baseComponents,
      // 行内代码
      code: ({ className, children, ...props }) => {
        const match = /language-([\w-]+)/.exec(className || '')
        const isBlock = 'node' in props && props.node?.position?.start.line !== props.node?.position?.end.line

        // 代码块
        if (match || isBlock) {
          const code = String(children).replace(/\n$/, '')
          // diff 代码块 → 用 pierre/diffs 渲染成规范的 diff 查看器
          if (match?.[1] === 'diff') {
            return wrapBlock('code', code, <MarkdownDiffBlock code={code} className="my-2" />, props.node?.position)
          }
          // JSON 代码块 → 交互式树形查看器
          if (match?.[1] === 'json') {
            return wrapBlock('code', code, <MarkdownJsonBlock code={code} className="my-2" />, props.node?.position)
          }
          // datatable 代码块 → 可排序/可筛选的数据表
          if (match?.[1] === 'datatable') {
            return wrapBlock('datatable', code, <MarkdownDatatableBlock code={code} className="my-2" />, props.node?.position)
          }
          // spreadsheet 代码块 → Excel 风格网格
          if (match?.[1] === 'spreadsheet') {
            return wrapBlock('spreadsheet', code, <MarkdownSpreadsheetBlock code={code} className="my-2" />, props.node?.position)
          }
          // html-preview 代码块 → 沙箱化 iframe
          if (match?.[1] === 'html-preview' && isPreviewEnabled('html-preview')) {
            return wrapBlock('html-preview', code, <MarkdownHtmlBlock code={code} className="my-2" />, props.node?.position)
          }
          // pdf-preview 代码块 → 内联首页,可展开到完整查看器
          if (match?.[1] === 'pdf-preview' && isPreviewEnabled('pdf-preview')) {
            return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={code} className="my-2" />, props.node?.position)
          }
          // image-preview 代码块 → 内联图片,可展开到完整查看器
          if (match?.[1] === 'image-preview' && isPreviewEnabled('image-preview')) {
            return wrapBlock('image-preview', code, <MarkdownImageBlock code={code} className="my-2" />, props.node?.position)
          }
          // markdown-preview 代码块 → 内联渲染 .md 文件
          if (match?.[1] === 'markdown-preview' && isPreviewEnabled('markdown-preview')) {
            return wrapBlock(
              'markdown-preview',
              code,
              <MarkdownDocBlock code={code} className="my-2" onUrlClick={onUrlClick} onFileClick={onFileClick} />,
              props.node?.position,
            )
          }
          // LaTeX/数学代码块 → KaTeX 渲染的展示型数学公式
          if (match?.[1] === 'latex' || match?.[1] === 'math') {
            return wrapBlock('latex', code, <MarkdownLatexBlock code={code} className="my-2" />, props.node?.position)
          }
          // mermaid 代码块 → zinc 风格的 SVG 图。
          // 当 mermaid block 是消息中的第一段内容时,隐藏内联展开按钮 ——
          // TurnCard 自己的全屏按钮占据了同一个右上角位置。这里通过
          // firstMermaidCodeRef 做内容匹配来判断,而非依赖 AST 行号,因为
          // preprocessLinks 改写 markdown 后行号已不可靠。
          if (match?.[1] === 'mermaid') {
            const isFirstBlock = hideFirstMermaidExpand &&
                                firstMermaidCodeRef?.current != null &&
                                code === firstMermaidCodeRef.current
            return wrapBlock(
              'mermaid',
              code,
              <MarkdownMermaidBlock code={code} className="my-2" showExpandButton={!isFirstBlock} />,
              props.node?.position,
            )
          }
          return wrapBlock('code', code, <CodeBlock code={code} language={match?.[1]} mode="full" className="my-2" />, props.node?.position)
        }

        // 行内代码
        return <InlineCode>{children}</InlineCode>
      },
      pre: ({ children }) => <>{children}</>,
      // 舒适的段落间距
      p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
      // 带样式的列表 - ul 用更紧凑的间距,ol 用标准间距以便数字对齐
      ul: ({ children, className }) => (
        <ul
          className={cn(
            'my-2 space-y-1 ps-[16px] pe-2 list-disc marker:text-[var(--md-bullets)]',
            className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
          )}
        >
          {children}
        </ul>
      ),
      ol: ({ children, className }) => (
        <ol className={cn('my-2 space-y-1 pl-6 list-decimal', className)}>{children}</ol>
      ),
      li: ({ children, className }) => (
        <li className={cn(className?.includes('task-list-item') && 'list-none')}>{children}</li>
      ),
      input: ({ type, checked }) => {
        if (type === 'checkbox') {
          return (
            <input
              type="checkbox"
              checked={checked}
              readOnly
              className="mr-2 rounded border-muted-foreground align-middle"
            />
          )
        }
        return <input type={type} />
      },
      // 简洁表格
      table: ({ children }) => (
        <div className="my-3 overflow-x-auto">
          <table className="min-w-full text-sm">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="border-b">{children}</thead>,
      th: ({ children }) => (
        <th className="text-left py-2 px-3 font-semibold text-muted-foreground">{children}</th>
      ),
      td: ({ children }) => (
        <td className="py-2 px-3 border-b border-border/50">{children}</td>
      ),
      // 标题 - H1/H2 字号相同,通过字重区分
      h1: ({ children }) => <h1 className="font-sans text-[16px] font-bold mt-5 mb-3">{children}</h1>,
      h2: ({ children }) => <h2 className="font-sans text-[16px] font-semibold mt-4 mb-3">{children}</h2>,
      h3: ({ children }) => <h3 className="font-sans text-[15px] font-semibold mt-4 mb-2">{children}</h3>,
      // 引用块
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
          {children}
        </blockquote>
      ),
      // 分隔线
      hr: () => <hr className="my-4 border-border" />,
      // 加粗/斜体
      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
      em: ({ children }) => <em className="italic">{children}</em>,
    }
  }

  // full 模式:富样式
  return {
    ...baseComponents,
    // 完整代码块,带复制按钮
    code: ({ className, children, ...props }) => {
      const match = /language-([\w-]+)/.exec(className || '')
      const isBlock = 'node' in props && props.node?.position?.start.line !== props.node?.position?.end.line

      if (match || isBlock) {
        const code = String(children).replace(/\n$/, '')
        // diff 代码块 → 用 pierre/diffs 渲染成规范的 diff 查看器
        if (match?.[1] === 'diff') {
          return wrapBlock('code', code, <MarkdownDiffBlock code={code} className="my-2" />, props.node?.position)
        }
        // JSON 代码块 → 交互式树形查看器
        if (match?.[1] === 'json') {
          return wrapBlock('code', code, <MarkdownJsonBlock code={code} className="my-2" />, props.node?.position)
        }
        // datatable 代码块 → 可排序/可筛选的数据表
        if (match?.[1] === 'datatable') {
          return wrapBlock('datatable', code, <MarkdownDatatableBlock code={code} className="my-2" />, props.node?.position)
        }
        // spreadsheet 代码块 → Excel 风格网格
        if (match?.[1] === 'spreadsheet') {
          return wrapBlock('spreadsheet', code, <MarkdownSpreadsheetBlock code={code} className="my-2" />, props.node?.position)
        }
        // html-preview 代码块 → 沙箱化 iframe
        if (match?.[1] === 'html-preview' && isPreviewEnabled('html-preview')) {
          return wrapBlock('html-preview', code, <MarkdownHtmlBlock code={code} className="my-2" />, props.node?.position)
        }
        // pdf-preview 代码块 → 内联首页,可展开到完整查看器
        if (match?.[1] === 'pdf-preview' && isPreviewEnabled('pdf-preview')) {
          return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={code} className="my-2" />, props.node?.position)
        }
        // image-preview 代码块 → 内联图片,可展开到完整查看器
        if (match?.[1] === 'image-preview' && isPreviewEnabled('image-preview')) {
          return wrapBlock('image-preview', code, <MarkdownImageBlock code={code} className="my-2" />, props.node?.position)
        }
        // markdown-preview 代码块 → 内联渲染 .md 文件
        if (match?.[1] === 'markdown-preview' && isPreviewEnabled('markdown-preview')) {
          return wrapBlock(
            'markdown-preview',
            code,
            <MarkdownDocBlock code={code} className="my-2" onUrlClick={onUrlClick} onFileClick={onFileClick} />,
            props.node?.position,
          )
        }
        // LaTeX/数学代码块 → KaTeX 渲染的展示型数学公式
        if (match?.[1] === 'latex' || match?.[1] === 'math') {
          return wrapBlock('latex', code, <MarkdownLatexBlock code={code} className="my-2" />, props.node?.position)
        }
        // mermaid 代码块 → zinc 风格的 SVG 图。
        // (首块检测逻辑同 minimal 模式,见上方注释。)
        if (match?.[1] === 'mermaid') {
          const isFirstBlock = hideFirstMermaidExpand &&
                              firstMermaidCodeRef?.current != null &&
                              code === firstMermaidCodeRef.current
          return wrapBlock(
            'mermaid',
            code,
            <MarkdownMermaidBlock code={code} className="my-2" showExpandButton={!isFirstBlock} />,
            props.node?.position,
          )
        }
        return wrapBlock('code', code, <CodeBlock code={code} language={match?.[1]} mode="full" className="my-2" />, props.node?.position)
      }

      return <InlineCode>{children}</InlineCode>
    },
    pre: ({ children }) => <>{children}</>,
    // 宽松的段落间距
    p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
    // 带样式的列表 - ul 用更紧凑的间距,ol 用标准间距以便数字对齐
    ul: ({ children, className }) => (
      <ul
        className={cn(
          'my-3 space-y-1.5 ps-[16px] pe-2 list-disc marker:text-[var(--md-bullets)]',
          className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ children, className }) => (
      <ol className={cn('my-3 space-y-1.5 pl-6 list-decimal', className)}>{children}</ol>
    ),
    li: ({ children, className }) => (
      <li className={cn('leading-relaxed', className?.includes('task-list-item') && 'list-none')}>{children}</li>
    ),
    // 精美表格
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y divide-border">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
    th: ({ children }) => (
      <th className="text-left py-3 px-4 font-semibold text-sm">{children}</th>
    ),
    td: ({ children }) => (
      <td className="py-3 px-4 text-sm">{children}</td>
    ),
    tr: ({ children }) => (
      <tr className="hover:bg-muted/30 transition-colors">{children}</tr>
    ),
    // 富样式标题 - H1/H2 字号相同,通过字重区分
    h1: ({ children }) => (
      <h1 className="font-sans text-[16px] font-bold mt-7 mb-4">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-sans text-[16px] font-semibold mt-6 mb-3">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-sans text-[15px] font-semibold mt-5 mb-3">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-[14px] font-semibold mt-3 mb-1">{children}</h4>
    ),
    // 带样式的引用块
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-foreground/30 bg-muted/30 pl-4 pr-3 py-2 my-3 rounded-r-md">
        {children}
      </blockquote>
    ),
    // 任务列表(GFM)
    input: ({ type, checked }) => {
      if (type === 'checkbox') {
        return (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="mr-2 rounded border-muted-foreground"
          />
        )
      }
      return <input type={type} />
    },
    // 分隔线
    hr: () => <hr className="my-6 border-border" />,
    // 加粗/斜体
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through text-muted-foreground">{children}</del>,
    // 处理可能来自 rehype-raw 的未知 <markdown> 标签
    // 需要类型断言,因为 'markdown' 不是标准 HTML 元素
    markdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  } as Partial<Components>
}

/**
 * Markdown - 可定制的 markdown 渲染器,支持多种渲染模式
 *
 * 特性:
 * - 三种渲染模式:terminal、minimal、full
 * - 基于 Shiki 的语法高亮
 * - 支持 GFM(表格、任务列表、删除线)
 * - 可点击的链接和文件路径
 * - 针对流式场景的 memoization
 */
export function Markdown({
  children,
  mode = 'minimal',
  className,
  id,
  onUrlClick,
  onFileClick,
  collapsible = false,
  hideFirstMermaidExpand = true,
  disablePreviewBlocks,
}: MarkdownProps) {
  // 若启用则获取可折叠 context
  const collapsibleContext = useCollapsibleMarkdown()

  // 当消息以 mermaid 围栏开头时,提取第一个 mermaid 代码块的内容。
  // 存入 ref,以便 createComponents 能读取它,而无需把 `children` 加入
  // memo 依赖(否则每次流式更新都会重新挂载所有组件,破坏内部状态)。
  const firstMermaidCodeRef = React.useRef<string | null>(null)
  const trimmed = children.trimStart()
  if (trimmed.startsWith('```mermaid')) {
    const m = trimmed.match(/^```mermaid\n([\s\S]*?)```/)
    firstMermaidCodeRef.current = m?.[1] ? m[1].replace(/\n$/, '') : null
  } else {
    firstMermaidCodeRef.current = null
  }

  const components = React.useMemo(
    () => wrapWithSafeProxy(createComponents(mode, onUrlClick, onFileClick, collapsible ? collapsibleContext : null, firstMermaidCodeRef, hideFirstMermaidExpand, disablePreviewBlocks)),
    [mode, onUrlClick, onFileClick, collapsible, collapsibleContext, hideFirstMermaidExpand, disablePreviewBlocks]
  )

  // 预处理:把原始 URL 和文件路径转换为 markdown 链接
  const processedContent = React.useMemo(
    () => preprocessLinks(children),
    [children]
  )

  // 根据条件决定是否引入可折叠 section 插件。
  // 重要:禁用单美元符号的行内数学,使 $2M–$4M 这类货币金额保持纯文本。
  // 数学公式应使用 $$...$$ 分隔符。
  const remarkPlugins = React.useMemo(
    () => {
      const mathPlugin: [typeof remarkMath, typeof MARKDOWN_MATH_OPTIONS] = [
        remarkMath,
        MARKDOWN_MATH_OPTIONS
      ]
      return collapsible
        ? [remarkGfm, mathPlugin, remarkCollapsibleSections]
        : [remarkGfm, mathPlugin]
    },
    [collapsible]
  )

  return (
    <div className={cn('markdown-content', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  )
}

/**
 * MemoizedMarkdown - 针对流式场景优化
 *
 * 将内容拆分为 block 并分别 memo,
 * 流式更新时只有新增/变化的 block 会重新渲染。
 */
export const MemoizedMarkdown = React.memo(
  Markdown,
  (prevProps, nextProps) => {
    // 若提供了 id,则基于 id 做 memoization
    if (prevProps.id && nextProps.id) {
      return (
        prevProps.id === nextProps.id &&
        prevProps.children === nextProps.children &&
        prevProps.mode === nextProps.mode &&
        prevProps.disablePreviewBlocks === nextProps.disablePreviewBlocks
      )
    }
    // 否则比较内容和模式
    return (
      prevProps.children === nextProps.children &&
      prevProps.mode === nextProps.mode &&
      prevProps.disablePreviewBlocks === nextProps.disablePreviewBlocks
    )
  }
)
MemoizedMarkdown.displayName = 'MemoizedMarkdown'

// 为方便使用而 re-export
export { CodeBlock, InlineCode } from './CodeBlock'
export { CollapsibleMarkdownProvider } from './CollapsibleMarkdownContext'
