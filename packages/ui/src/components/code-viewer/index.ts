/**
 * 代码查看器组件,用于语法高亮和 diff 展示。
 */

export { ShikiCodeViewer, type ShikiCodeViewerProps } from './ShikiCodeViewer'
export { ShikiDiffViewer, type ShikiDiffViewerProps, getDiffStats } from './ShikiDiffViewer'
export { UnifiedDiffViewer, type UnifiedDiffViewerProps, getUnifiedDiffStats } from './UnifiedDiffViewer'
export { DiffViewerControls, type DiffViewerControlsProps } from './DiffViewerControls'
export { DiffSplitIcon, DiffUnifiedIcon, DiffBackgroundIcon } from './DiffIcons'
export { LANGUAGE_MAP, getLanguageFromPath, formatFilePath, truncateFilePath } from './language-map'
