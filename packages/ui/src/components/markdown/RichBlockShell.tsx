import * as React from 'react'
import { Pencil } from 'lucide-react'
import { cn } from '../../lib/utils'
import { TiptapHoverActionsHost, TiptapHoverActions, TiptapHoverActionButton } from './TiptapHoverActions'

interface RichBlockShellProps {
  children: React.ReactNode
  onEdit?: () => void
  editTitle?: string
  className?: string
}

export function RichBlockShell({ children, onEdit, editTitle = 'Edit block', className }: RichBlockShellProps) {
  return (
    <TiptapHoverActionsHost className={cn('group', className)}>
      {onEdit && (
        <TiptapHoverActions>
          <TiptapHoverActionButton
            onMouseDown={(event) => {
              // 保持焦点/选区在 ProseMirror 内,使 BubbleMenu 锚点在首次打开时稳定。
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onEdit()
            }}
            className="rich-block-edit-button"
            title={editTitle}
            aria-label={editTitle}
          >
            <Pencil className="w-3.5 h-3.5" />
          </TiptapHoverActionButton>
        </TiptapHoverActions>
      )}
      {children}
    </TiptapHoverActionsHost>
  )
}
