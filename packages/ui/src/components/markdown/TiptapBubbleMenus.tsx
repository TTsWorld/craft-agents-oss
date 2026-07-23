import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BubbleMenu } from '@tiptap/react/menus'
import type { Editor } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { Bold, Italic, Strikethrough, Code, Sigma } from 'lucide-react'
import { cn } from '../../lib/utils'
import { RICH_BLOCK_EDIT_EVENT } from './rich-block-events'

// 用于发出"打开行内数学公式编辑器"信号的自定义事件名
const INLINE_MATH_EDIT_EVENT = 'inlineMathEdit'

// ============================================================================
// 气泡菜单工具栏按钮
// ============================================================================

function BubbleButton({
  onClick,
  isActive,
  title,
  children,
}: {
  onClick: () => void
  isActive?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'tiptap-bubble-btn',
        isActive && 'is-active',
      )}
    >
      {children}
    </button>
  )
}

// ============================================================================
// 文本格式化气泡菜单 —— 加粗、斜体、删除线、行内代码
// ============================================================================

function TextFormattingMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation()
  return (
    <div className="tiptap-bubble-menu">
      <BubbleButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive('bold')}
        title={t('editor.bold')}
      >
        <Bold className="w-3.5 h-3.5" />
      </BubbleButton>

      <BubbleButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive('italic')}
        title={t('editor.italic')}
      >
        <Italic className="w-3.5 h-3.5" />
      </BubbleButton>

      <BubbleButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive('strike')}
        title={t('editor.strikethrough')}
      >
        <Strikethrough className="w-3.5 h-3.5" />
      </BubbleButton>

      <BubbleButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        isActive={editor.isActive('code')}
        title={t('editor.code')}
      >
        <Code className="w-3.5 h-3.5" />
      </BubbleButton>

      <BubbleButton
        onClick={() => {
          const { from, to } = editor.state.selection
          const selectedText = editor.state.doc.textBetween(from, to)
          // 删除选中文本,然后以该文本为 latex 插入 inlineMath 节点
          editor.chain().focus()
            .deleteSelection()
            .insertInlineMath({ latex: selectedText })
            .run()
          // 在新建节点上打开编辑浮层
          const newPos = editor.state.selection.from - 1
          const node = editor.state.doc.nodeAt(newPos)
          if (node?.type.name === 'inlineMath') {
            editor.chain().setNodeSelection(newPos).run()
            queueMicrotask(() => (editor as any).emit(INLINE_MATH_EDIT_EVENT))
          }
        }}
        title={t('editor.math')}
      >
        <Sigma className="w-3.5 h-3.5" />
      </BubbleButton>
    </div>
  )
}

// ============================================================================
// 代码块编辑气泡菜单 —— mermaid / latex 块的编辑浮层
// ============================================================================

const VISUAL_LANGUAGES = new Set(['mermaid', 'latex', 'math', 'tex', 'katex'])

function getEditableBlockMeta(editor: Editor): { label: string; code: string; update: (next: string) => void } | null {
  const { selection } = editor.state

  if (selection instanceof NodeSelection) {
    const node = selection.node
    const pos = selection.from

    if (node.type.name === 'mermaidBlock') {
      return {
        label: 'Mermaid',
        code: String(node.attrs.code ?? ''),
        update: (next) => {
          editor.chain().focus().setNodeSelection(pos).updateAttributes('mermaidBlock', { code: next }).run()
        },
      }
    }

    if (node.type.name === 'latexBlock') {
      return {
        label: 'LaTeX',
        code: String(node.attrs.code ?? ''),
        update: (next) => {
          editor.chain().focus().setNodeSelection(pos).updateAttributes('latexBlock', { code: next }).run()
        },
      }
    }

    return null
  }

  // 当旧文档/代码路径仍包含 codeBlock 的 language 变体时的兼容回退。
  const { $from } = selection
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name !== 'codeBlock') continue

    const lang = (node.attrs.language as string | undefined)?.toLowerCase() ?? ''
    if (!VISUAL_LANGUAGES.has(lang)) return null

    const label = lang === 'mermaid' ? 'Mermaid' : 'LaTeX'
    const pos = $from.before(depth)

    return {
      label,
      code: node.textContent,
      update: (next) => {
        const tr = editor.state.tr.replaceWith(
          pos + 1,
          pos + node.nodeSize - 1,
          next.length > 0 ? editor.schema.text(next) : editor.schema.text(' '),
        )
        editor.view.dispatch(tr)
      },
    }
  }

  return null
}

function RichBlockEditMenu({ editor }: { editor: Editor }) {
  const [isEditing, setIsEditing] = React.useState(false)
  const [positionReady, setPositionReady] = React.useState(false)
  const [code, setCode] = React.useState('')
  const [label, setLabel] = React.useState('Block')
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  const openEditor = React.useCallback(() => {
    const meta = getEditableBlockMeta(editor)
    if (!meta) return
    setLabel(meta.label)
    setCode(meta.code)
    setPositionReady(false)
    setIsEditing(true)
  }, [editor])

  React.useEffect(() => {
    const activate = () => {
      openEditor()
    }
    ;(editor as any).on(RICH_BLOCK_EDIT_EVENT, activate)
    return () => { (editor as any).off(RICH_BLOCK_EDIT_EVENT, activate) }
  }, [editor, openEditor])

  const commitEdit = React.useCallback(() => {
    const meta = getEditableBlockMeta(editor)
    if (!meta) {
      setPositionReady(false)
      setIsEditing(false)
      return
    }

    meta.update(code)
    setPositionReady(false)
    setIsEditing(false)
  }, [editor, code])

  React.useEffect(() => {
    if (!isEditing) return

    const syncOrClose = () => {
      const meta = getEditableBlockMeta(editor)
      if (!meta) {
        setPositionReady(false)
        setIsEditing(false)
        return
      }
      setLabel(meta.label)
    }

    editor.on('selectionUpdate', syncOrClose)
    return () => {
      editor.off('selectionUpdate', syncOrClose)
    }
  }, [editor, isEditing])

  // textarea 自动调整高度
  React.useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      const el = textareaRef.current
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`

      // 首次渲染后内容高度会变化;强制 BubbleMenu 重新计算定位。
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return
        const tr = editor.state.tr.setMeta('richBlockEdit', 'updatePositionAfterResize')
        editor.view.dispatch(tr)
      })
    }
  }, [editor, isEditing, code])

  // BubbleMenu 依据 ProseMirror transaction/resize 定位,而非仅靠 React state 变化。
  // 进入编辑模式会改变浮层内容尺寸/锚点上下文,因此需要强制重新定位。
  React.useEffect(() => {
    if (!isEditing) return

    let raf2: number | null = null
    let raf3: number | null = null
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const tr = editor.state.tr.setMeta('richBlockEdit', 'updatePosition')
        editor.view.dispatch(tr)

        // 下一帧再显示,以便 floating-ui 先应用计算好的位置。
        raf3 = requestAnimationFrame(() => {
          setPositionReady(true)
        })
      })
    })

    return () => {
      cancelAnimationFrame(raf1)
      if (raf2 != null) cancelAnimationFrame(raf2)
      if (raf3 != null) cancelAnimationFrame(raf3)
    }
  }, [editor, isEditing])

  if (!isEditing) {
    return null
  }

  return (
    <div
      className="tiptap-bubble-menu tiptap-bubble-menu--editing"
      style={!positionReady ? { opacity: 0, pointerEvents: 'none' } : undefined}
    >
      <div className="tiptap-bubble-edit-header">
        <span className="tiptap-bubble-label tiptap-bubble-panel-title">{label}</span>
        <button
          type="button"
          className="tiptap-bubble-done-btn"
          onClick={commitEdit}
        >
          Done
        </button>
      </div>
      <div className="tiptap-bubble-textarea-shell">
        <textarea
          ref={textareaRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              commitEdit()
            }
            e.stopPropagation()
          }}
          className="tiptap-bubble-textarea"
          spellCheck={false}
        />
      </div>
    </div>
  )
}

// ============================================================================
// 行内数学公式编辑菜单 —— $...$ 数学节点的编辑浮层
// ============================================================================

function InlineMathEditMenu({ editor }: { editor: Editor }) {
  const [editActive, setEditActive] = React.useState(false)
  const [latex, setLatex] = React.useState('')
  const [nodePos, setNodePos] = React.useState<number | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 监听自定义的"激活编辑"事件(由点击处理器和 Enter 键处理器触发)
  React.useEffect(() => {
    const activate = () => {
      setEditActive(true)
      // 从当前选区同步 latex 值
      const { selection } = editor.state
      if (selection instanceof NodeSelection && selection.node.type.name === 'inlineMath') {
        setLatex(selection.node.attrs.latex as string)
        setNodePos(selection.from)
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => inputRef.current?.focus())
      })
    }
    ;(editor as any).on(INLINE_MATH_EDIT_EVENT, activate)
    return () => { (editor as any).off(INLINE_MATH_EDIT_EVENT, activate) }
  }, [editor])

  // 激活时也在 selectionUpdate 时同步 latex/nodePos(例如节点周围的文档发生变化)
  React.useEffect(() => {
    if (!editActive) return
    const sync = () => {
      const { selection } = editor.state
      if (selection instanceof NodeSelection && selection.node.type.name === 'inlineMath') {
        setNodePos(selection.from)
      }
    }
    editor.on('selectionUpdate', sync)
    return () => { editor.off('selectionUpdate', sync) }
  }, [editor, editActive])

  const deactivateAndMove = React.useCallback((targetPos: number) => {
    setEditActive(false)
    editor.chain().focus().setTextSelection(targetPos).run()
  }, [editor])

  const commitEdit = React.useCallback(() => {
    if (nodePos == null) return
    setEditActive(false)
    if (latex.trim().length === 0) {
      editor.chain().focus().deleteInlineMath({ pos: nodePos }).run()
    } else {
      const node = editor.state.doc.nodeAt(nodePos)
      const afterPos = node ? nodePos + node.nodeSize : nodePos + 1
      editor.chain().focus().updateInlineMath({ latex, pos: nodePos }).setTextSelection(afterPos).run()
    }
  }, [editor, latex, nodePos])

  return (
    <div
      className="tiptap-bubble-menu tiptap-bubble-menu--inline-math"
      style={!editActive ? { opacity: 0, pointerEvents: 'none' } : undefined}
    >
      <input
        ref={inputRef}
        type="text"
        value={latex}
        onChange={(e) => setLatex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitEdit()
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            if (nodePos != null) {
              const node = editor.state.doc.nodeAt(nodePos)
              const afterPos = node ? nodePos + node.nodeSize : nodePos + 1
              deactivateAndMove(afterPos)
            }
            return
          }
          // 在输入起始处按左方向键 → 提交并把光标置于节点之前
          if (e.key === 'ArrowLeft' && inputRef.current?.selectionStart === 0) {
            e.preventDefault()
            if (nodePos != null && latex.trim().length > 0) {
              setEditActive(false)
              editor.chain().focus().updateInlineMath({ latex, pos: nodePos }).setTextSelection(nodePos).run()
            } else if (nodePos != null) {
              const node = editor.state.doc.nodeAt(nodePos)
              const afterPos = node ? nodePos + node.nodeSize : nodePos + 1
              deactivateAndMove(afterPos)
            }
            return
          }
          // 在输入末尾处按右方向键 → 提交并把光标置于节点之后
          if (e.key === 'ArrowRight' && inputRef.current?.selectionStart === latex.length) {
            e.preventDefault()
            commitEdit()
            return
          }
          e.stopPropagation()
        }}
        onBlur={commitEdit}
        className="tiptap-bubble-math-input"
        spellCheck={false}
      />
    </div>
  )
}

// ============================================================================
// 导出的组合组件:TipTap 编辑器的全部气泡菜单
// ============================================================================

export { INLINE_MATH_EDIT_EVENT }

const TIPTAP_BUBBLE_MENU_Z_INDEX = 'var(--z-floating-menu, 400)'
const TIPTAP_BUBBLE_MENU_BASE_OPTIONS = {
  // 保持默认的定位策略/portal 行为。
  // `fixed + appendTo(body)` 在嵌套/动画布局中首次显示时可能发生漂移。
  zIndex: TIPTAP_BUBBLE_MENU_Z_INDEX,
}

export function TiptapBubbleMenus({ editor }: { editor: Editor }) {
  const getRichBlockEditAnchor = React.useCallback(() => {
    const { selection } = editor.state
    if (!(selection instanceof NodeSelection)) return null

    const name = selection.node.type.name
    if (name !== 'mermaidBlock' && name !== 'latexBlock') return null

    const getRect = () => {
      // 首选路径:选中节点 DOM 内编辑按钮的边界。
      const selectedNodeDom = editor.view.nodeDOM(selection.from)
      if (selectedNodeDom instanceof HTMLElement) {
        const selectedButton = selectedNodeDom.querySelector('.rich-block-edit-button')
        if (selectedButton instanceof HTMLElement) {
          return selectedButton.getBoundingClientRect()
        }

        // 回退:选中节点包裹元素的 rect。
        const nodeRect = selectedNodeDom.getBoundingClientRect()
        if (nodeRect.width > 0 && nodeRect.height > 0) {
          return nodeRect
        }
      }

      // 最终回退:ProseMirror 坐标(只要选区存在就可用)。
      // 用节点左上角附近的一个极小虚拟 rect 作为确定性锚点。
      const coords = editor.view.coordsAtPos(selection.from)
      return new DOMRect(coords.left, coords.top, 1, 1)
    }

    return {
      getBoundingClientRect: getRect,
      getClientRects: () => [getRect()],
    }
  }, [editor])

  return (
    <>
      {/* 文本格式化 —— 选中文本时显示,代码块内隐藏 */}
      <BubbleMenu
        editor={editor}
        pluginKey="textFormatting"
        updateDelay={0}
        shouldShow={({ editor: e, state }) => {
          const { selection } = state
          if (selection.from === selection.to) return false
          if (selection instanceof NodeSelection) return false
          if (e.isActive('codeBlock')) return false
          return true
        }}
        options={{ ...TIPTAP_BUBBLE_MENU_BASE_OPTIONS, placement: 'top', offset: 8 }}
      >
        <TextFormattingMenu editor={editor} />
      </BubbleMenu>

      {/* 富块编辑 —— 选中 Mermaid/LaTeX 富块时显示(含旧版 codeBlock 回退)。 */}
      <BubbleMenu
        editor={editor}
        pluginKey="richBlockEdit"
        updateDelay={0}
        shouldShow={({ state, editor: e }) => {
          if (state.selection instanceof NodeSelection) {
            const name = state.selection.node.type.name
            if (name === 'mermaidBlock' || name === 'latexBlock') return true
          }

          if (!e.isActive('codeBlock')) return false
          const lang = (e.getAttributes('codeBlock').language as string | undefined)?.toLowerCase()
          return lang != null && VISUAL_LANGUAGES.has(lang)
        }}
        getReferencedVirtualElement={getRichBlockEditAnchor}
        options={{
          ...TIPTAP_BUBBLE_MENU_BASE_OPTIONS,
          placement: 'left-start',
          offset: { mainAxis: 8, crossAxis: 0 },
          shift: false,
          flip: false,
        }}
      >
        <RichBlockEditMenu editor={editor} />
      </BubbleMenu>

      {/* 行内数学公式编辑 —— 选中 inlineMath 时始终挂载;内容可见性由 InlineMathEditMenu 控制 */}
      <BubbleMenu
        editor={editor}
        pluginKey="inlineMathEdit"
        updateDelay={0}
        shouldShow={({ state }) => {
          const { selection } = state
          return selection instanceof NodeSelection && selection.node.type.name === 'inlineMath'
        }}
        options={{ ...TIPTAP_BUBBLE_MENU_BASE_OPTIONS, placement: 'top', offset: 8 }}
      >
        <InlineMathEditMenu editor={editor} />
      </BubbleMenu>
    </>
  )
}
