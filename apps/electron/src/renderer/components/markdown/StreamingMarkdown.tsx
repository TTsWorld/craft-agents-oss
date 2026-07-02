/**
 * StreamingMarkdown.tsx
 *
 * 用于 Electron 渲染进程的“流式 Markdown”渲染器。
 *
 * 在 Agent 场景中，模型回复通常以 stream（流）的形式逐段到达，而不是一次性返回完整文本。
 * 如果每次收到新片段都重新渲染整段 Markdown，会导致页面频繁闪烁、性能变差。
 * 本组件把内容拆成若干“块”（段落 / 代码块），对每个块做缓存（memoization），
 * 只有正在流式输出的最后一块会重新渲染，已完成的块保持不动。
 *
 * 核心思路类似 Golang 里对不变对象做缓存：内容相同的块用相同 key，React 就会跳过重复渲染。
 */

import * as React from 'react'
import { Markdown, type RenderMode } from '@craft-agent/ui'

// 组件外部可传入的属性（Props），功能类似 Golang 中某个函数的配置结构体
interface StreamingMarkdownProps {
  content: string
  isStreaming: boolean
  mode?: RenderMode
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}

// 内容块的内部数据结构：一段文本 + 标记它是不是代码块
interface Block {
  content: string
  isCodeBlock: boolean
}

/**
 * 简易哈希函数，用于给缓存 key 生成短字符串。
 *
 * 采用 djb2 算法：速度快、分布较均匀，适合把长文本映射成短的 React key。
 * React key 只是组件的身份标识，不需要密码学安全，这里“够用就行”。
 */
function simpleHash(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    // hash * 33 后异或当前字符的 Unicode 码点
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }
  // >>> 0 把有符号数转成无符号 32 位整数，再转 36 进制字符串（0-9a-z），更短
  return (hash >>> 0).toString(36)
}

/**
 * 把原始文本拆成“块”数组（段落 或 代码块）。
 *
 * 块的边界：
 * - 两个换行符之间视为一个段落（paragraph）
 * - Markdown 代码围栏 ``` 包裹的部分视为一个代码块
 *
 * 实现故意保持简单：逐行扫描字符串，每行只做一次 startsWith 判断，不用正则。
 * 这样在流式输出高频更新时开销很低。
 */
function splitIntoBlocks(content: string): Block[] {
  const blocks: Block[] = []
  const lines = content.split('\n')
  let currentBlock = ''
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 判断是否是代码围栏：行首是 ```，后面可能跟着语言名（如 ```typescript）
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        // 开始进入代码块：先把之前累积的普通段落 flush 出去
        if (currentBlock.trim()) {
          blocks.push({ content: currentBlock.trim(), isCodeBlock: false })
          currentBlock = ''
        }
        inCodeBlock = true
        currentBlock = line + '\n'
      } else {
        // 结束代码块：把围栏和中间内容一起作为一个块
        currentBlock += line
        blocks.push({ content: currentBlock, isCodeBlock: true })
        currentBlock = ''
        inCodeBlock = false
      }
    } else if (inCodeBlock) {
      // 当前处于代码块内部，直接追加行，保留换行（代码格式依赖换行）
      currentBlock += line + '\n'
    } else if (line === '') {
      // 普通文本中的空行 = 段落边界
      if (currentBlock.trim()) {
        blocks.push({ content: currentBlock.trim(), isCodeBlock: false })
        currentBlock = ''
      }
    } else {
      // 普通文本行
      if (currentBlock) {
        currentBlock += '\n' + line
      } else {
        currentBlock = line
      }
    }
  }

  // 循环结束后，把最后还没 flush 的内容推入数组
  // 如果还在代码块里却遇到了 EOF，说明代码块还没闭合（流式输出中很常见），按代码块处理
  if (currentBlock) {
    blocks.push({
      content: inCodeBlock ? currentBlock : currentBlock.trim(),
      isCodeBlock: inCodeBlock // 未闭合的代码块 = 仍在流式输出中
    })
  }

  return blocks
}

/**
 * 被缓存的“块”组件。
 *
 * React.memo 是 React 提供的高阶组件：如果 props 没变，就跳过重新渲染。
 * 类比 Golang：有点像把计算结果缓存起来，入参不变就不重算。
 *
 * 父组件会根据内容哈希生成 key；key 相同的块 React 会直接复用，连 memo 比较都不会走。
 * 所以本组件只需要比较 content 和 mode 是否真的改变。
 */
const MemoizedBlock = React.memo(function Block({
  content,
  mode,
  onUrlClick,
  onFileClick,
}: {
  content: string
  mode: RenderMode
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}) {
  return (
    <Markdown mode={mode} onUrlClick={onUrlClick} onFileClick={onFileClick}>
      {content}
    </Markdown>
  )
}, (prev, next) => {
  // 自定义比较函数：只有 content 或 mode 真正变化时才重新渲染
  return prev.content === next.content && prev.mode === next.mode
})

// displayName 是调试时在 React DevTools 里看到的组件名，建议给匿名/包裹组件加上
MemoizedBlock.displayName = 'MemoizedBlock'

/**
 * StreamingMarkdown：针对流式内容优化的 Markdown 渲染组件。
 *
 * 把内容拆成多个块（段落、代码块），每个块单独缓存（memoize）。
 * 流式输出时只有最后一个“活动”块会重新渲染，已完成块保持不变。
 *
 * 核心技巧：已完成块用内容哈希作为 React key；
 * 内容相同 → key 相同 → React 直接复用，不再渲染。
 *
 * @example
 * 原始内容: "Hello\n\n```js\ncode\n```\n\nMore..."
 *
 * 块 1: "Hello"           → key="block-abc123" → 已缓存 ✓
 * 块 2: "```js\ncode\n```" → key="block-xyz789" → 已缓存 ✓
 * 块 3: "More..."         → key="active-2"     → 持续重新渲染
 */
export function StreamingMarkdown({
  content,
  isStreaming,
  mode = 'minimal',
  onUrlClick,
  onFileClick,
}: StreamingMarkdownProps) {
  // 把文本拆成块。用 useMemo 缓存，避免每次渲染都重新拆分。
  // 注意：Hooks 调用必须“无条件”出现在组件顶部，所以这里不能放到 if 分支里。
  const blocks = React.useMemo(
    () => (isStreaming ? splitIntoBlocks(content) : []),
    [content, isStreaming]
  )

  // 不在流式状态时不需要拆块，直接用普通 Markdown 组件即可
  if (!isStreaming) {
    return (
      <Markdown mode={mode} onUrlClick={onUrlClick} onFileClick={onFileClick}>
        {content}
      </Markdown>
    )
  }

  return (
    <>
      {blocks.map((block, i) => {
        const isLastBlock = i === blocks.length - 1

        // 已完成块用内容哈希作为 key：key 稳定 → React 会复用并跳过渲染
        // 最后一个块用 "active" 前缀作为 key：key 不变，但 content 会变，因此会重新渲染
        const key = isLastBlock
          ? `active-${i}`
          : `block-${simpleHash(block.content)}`

        return (
          <MemoizedBlock
            key={key}
            content={block.content}
            mode={mode}
            onUrlClick={onUrlClick}
            onFileClick={onFileClick}
          />
        )
      })}
    </>
  )
}
