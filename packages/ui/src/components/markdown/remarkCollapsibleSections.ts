/**
 * 将标题 + 内容组合包装为 section 节点的 remark 插件。
 *
 * 对于每个标题（H1-H6），收集到下一个同级或更高级别标题之前的所有内容，
 * 并将它们包装在一个 section 节点中。
 *
 * 示例：
 *   ## Intro       -> section[depth=2]
 *     paragraph       包含：heading, paragraph, paragraph, section[depth=3]
 *     paragraph
 *     ### Details  -> section[depth=3]（嵌套在 Intro section 内）
 *       paragraph     包含：heading, paragraph
 *   ## Next       -> section[depth=2]
 */

import { visit } from 'unist-util-visit'
import type { Plugin } from 'unified'
import type { Root, Content, Heading, Parent } from 'mdast'

interface SectionNode extends Parent {
  type: 'section'
  depth: number
  data: {
    hName: 'div'
    hProperties: {
      'data-section-id': string
      'data-heading-level': number
      className: string
    }
  }
  children: Content[]
}

// 模块级计数器，每次解析时重置
let sectionCounter = 0

/**
 * remarkCollapsibleSections
 *
 * 转换 markdown AST，将标题+内容组合包装为可渲染为折叠区块的 section 节点。
 */
const remarkCollapsibleSections: Plugin<[], Root> = () => {
  return (tree: Root) => {
    // 每个文档重置计数器
    sectionCounter = 0

    // 从最深到最浅处理（6 -> 1）
    // 确保嵌套 section 在其父级之前创建
    for (let depth = 6; depth >= 1; depth--) {
      wrapHeadingsAtDepth(tree, depth)
    }
  }
}

function wrapHeadingsAtDepth(tree: Root, depth: number): void {
  // 需要手动迭代，因为我们正在修改树
  const processNode = (parent: Parent) => {
    let i = 0
    while (i < parent.children.length) {
      const node = parent.children[i]
      if (!node) {
        i++
        continue
      }

      // 递归处理已存在的 section（用于嵌套内容）
      // 注意：'section' 是我们的自定义节点类型，不在 mdast 类型中
      if ((node as { type: string }).type === 'section') {
        processNode(node as Parent)
        i++
        continue
      }

      // 找到目标层级的标题
      if (node.type === 'heading' && (node as Heading).depth === depth) {
        const sectionId = `section-${++sectionCounter}`

        // 查找此 section 的结束位置（下一个同级或更高级标题）
        let endIndex = i + 1
        while (endIndex < parent.children.length) {
          const sibling = parent.children[endIndex]
          if (!sibling) break

          // 遇到同级或更高级标题（数字更小）时停止
          if (sibling.type === 'heading' && (sibling as Heading).depth <= depth) {
            break
          }

          // 遇到包含同级或更高级标题的 section 时停止
          //（已处理更深层的 section）
          // 注意：'section' 是我们的自定义节点类型，不在 mdast 类型中
          if ((sibling as { type: string }).type === 'section' && (sibling as unknown as SectionNode).depth <= depth) {
            break
          }

          endIndex++
        }

        // 提取此 section 的节点
        const sectionChildren = parent.children.slice(i, endIndex) as Content[]

        // Create section wrapper
        const section: SectionNode = {
          type: 'section',
          depth,
          children: sectionChildren,
          data: {
            hName: 'div',
            hProperties: {
              'data-section-id': sectionId,
              'data-heading-level': depth,
              className: 'markdown-section',
            },
          },
        }

        // 用 section 替换标题及其内容
        parent.children.splice(i, sectionChildren.length, section as unknown as Content)
      }

      i++
    }
  }

  processNode(tree)
}

export default remarkCollapsibleSections
