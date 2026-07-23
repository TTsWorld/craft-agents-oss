import * as React from 'react'

interface CollapsibleMarkdownContextValue {
  /** 当前处于折叠状态的 section ID 集合 */
  collapsedSections: Set<string>
  /** 切换某个 section 的折叠状态 */
  toggleSection: (sectionId: string) => void
  /** 展开所有 section */
  expandAll: () => void
}

const CollapsibleMarkdownContext = React.createContext<CollapsibleMarkdownContextValue | null>(null)

/**
 * 用于访问可折叠 markdown context 的 hook。
 * 若未处于 provider 内则返回 null(用于非折叠模式)。
 */
export function useCollapsibleMarkdown(): CollapsibleMarkdownContextValue | null {
  return React.useContext(CollapsibleMarkdownContext)
}

interface CollapsibleMarkdownProviderProps {
  children: React.ReactNode
}

/**
 * CollapsibleMarkdownProvider
 *
 * 为可折叠的 markdown section 提供状态管理。
 * 所有 section 默认展开(折叠集合为空)。
 */
export function CollapsibleMarkdownProvider({ children }: CollapsibleMarkdownProviderProps) {
  const [collapsedSections, setCollapsedSections] = React.useState<Set<string>>(() => new Set())

  const toggleSection = React.useCallback((sectionId: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) {
        next.delete(sectionId)
      } else {
        next.add(sectionId)
      }
      return next
    })
  }, [])

  const expandAll = React.useCallback(() => {
    setCollapsedSections(new Set())
  }, [])

  const value = React.useMemo(
    () => ({ collapsedSections, toggleSection, expandAll }),
    [collapsedSections, toggleSection, expandAll]
  )

  return (
    <CollapsibleMarkdownContext.Provider value={value}>
      {children}
    </CollapsibleMarkdownContext.Provider>
  )
}
