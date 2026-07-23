/**
 * @craft-agent/ui - Craft Agent 的共享 React UI 组件
 *
 * 该包提供平台无关的 UI 组件，可同时运行于：
 * - Electron 桌面应用（完整交互模式）
 * - Web 会话查看器（只读模式）
 *
 * 核心组件：
 * - SessionViewer：只读会话记录查看器（供 Web 查看器使用）
 * - TurnCard：类邮件形式的助手 turn 展示
 * - Markdown：可定制的 Markdown 渲染器，支持语法高亮
 *
 * 平台抽象：
 * - PlatformProvider/usePlatform：注入平台特定操作
 */

// Context
export {
  PlatformProvider,
  usePlatform,
  usePlatform,
  type PlatformActions,
  type PlatformProviderProps,
  ShikiThemeProvider,
  useShikiTheme,
  type ShikiThemeProviderProps,
} from './context'

// Chat components
export {
  SessionViewer,
  TurnCard,
  TurnCardActionsMenu,
  ResponseCard,
  UserMessageBubble,
  SystemMessage,
  FileTypeIcon,
  getFileTypeLabel,
  asRecord,
  getAnnotationNoteText,
  getAnnotationFollowUpState,
  isAnnotationFollowUpSent,
  extractAnnotationSelectedText,
  normalizeFollowUpText,
  // 供 EditPopover 使用的内联执行
  InlineExecution,
  mapToolEventToActivity,
  SIZE_CONFIG,
  ActivityStatusIcon,
  type SessionViewerProps,
  type SessionViewerMode,
  type TurnCardProps,
  type TurnCardActionsMenuProps,
  type ResponseCardProps,
  type UserMessageBubbleProps,
  type SystemMessageProps,
  type SystemMessageType,
  type FileTypeIconProps,
  type ActivityItem,
  type ActivityStatus,
  type ResponseContent,
  type TodoItem,
  type InlineExecutionProps,
  type InlineExecutionStatus,
  type InlineActivityItem,
} from './components/chat'

// Markdown
export {
  Markdown,
  MemoizedMarkdown,
  CodeBlock,
  InlineCode,
  CollapsibleMarkdownProvider,
  useCollapsibleMarkdown,
  MarkdownDatatableBlock,
  MarkdownSpreadsheetBlock,
  MarkdownImageBlock,
  ImageCardStack,
  type MarkdownProps,
  type RenderMode,
  TiptapMarkdownEditor,
  type TiptapMarkdownEditorProps,
  type MarkdownEngine,
  type MarkdownDatatableBlockProps,
  type MarkdownSpreadsheetBlockProps,
  type MarkdownImageBlockProps,
  type ImageCardStackProps,
  type ImageCardStackItem,
} from './components/markdown'

// UI primitives
export {
  Spinner,
  LoadingIndicator,
  SimpleDropdown,
  SimpleDropdownItem,
  PreviewHeader,
  PreviewHeaderBadge,
  PREVIEW_BADGE_VARIANTS,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuShortcut,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
  BrowserShader,
  BrowserControls,
  BrowserEmptyStateCard,
  FilterableSelectPopover,
  Island,
  IslandContentView,
  IslandFollowUpContentView,
  useIslandNavigation,
  type SpinnerProps,
  type LoadingIndicatorProps,
  type SimpleDropdownProps,
  type SimpleDropdownItemProps,
  type PreviewHeaderProps,
  type PreviewHeaderBadgeProps,
  type PreviewBadgeVariant,
  type BrowserShaderProps,
  type BrowserControlsProps,
  type BrowserEmptyStateCardProps,
  type BrowserEmptyPromptSample,
  type FilterableSelectPopoverProps,
  type FilterableSelectRenderState,
  type IslandProps,
  type IslandContentViewProps,
  type IslandTransitionConfig,
  type IslandActiveViewSize,
  type IslandMorphTarget,
  type IslandFollowUpContentViewProps,
  type IslandFollowUpMode,
  type IslandNavigation,
  type IslandDialogBehavior,
  type AnchorX,
  type AnchorY,
} from './components/ui'

// Tooltip
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from './components/tooltip'

// Code viewer components
export {
  ShikiCodeViewer,
  ShikiDiffViewer,
  getDiffStats,
  UnifiedDiffViewer,
  getUnifiedDiffStats,
  DiffViewerControls,
  DiffSplitIcon,
  DiffUnifiedIcon,
  DiffBackgroundIcon,
  LANGUAGE_MAP,
  getLanguageFromPath,
  formatFilePath,
  truncateFilePath,
  type ShikiCodeViewerProps,
  type ShikiDiffViewerProps,
  type UnifiedDiffViewerProps,
  type DiffViewerControlsProps,
} from './components/code-viewer'

// Terminal components
export {
  TerminalOutput,
  parseAnsi,
  stripAnsi,
  isGrepContentOutput,
  parseGrepOutput,
  ANSI_COLORS,
  type TerminalOutputProps,
  type ToolType,
  type AnsiSpan,
  type GrepLine,
} from './components/terminal'

// Overlay components
export {
  // 基础浮层组件
  FullscreenOverlayBase,
  FullscreenOverlayBaseHeader,
  PreviewOverlay,
  ContentFrame,
  CopyButton,
  type FullscreenOverlayBaseProps,
  type FullscreenOverlayBaseHeaderProps,
  type OverlayTypeBadge,
  type PreviewOverlayProps,
  type ContentFrameProps,
  type BadgeVariant,
  type CopyButtonProps,
  // 专用浮层
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  GenericOverlay,
  JSONPreviewOverlay,
  DataTableOverlay,
  DocumentFormattedMarkdownOverlay,
  ImagePreviewOverlay,
  PDFPreviewOverlay,
  detectLanguage,
  detectLanguageFromPath,
  type CodePreviewOverlayProps,
  type MultiDiffPreviewOverlayProps,
  type FileChange,
  type DiffViewerSettings,
  type TerminalPreviewOverlayProps,
  type GenericOverlayProps,
  type JSONPreviewOverlayProps,
  type DataTableOverlayProps,
  type DocumentFormattedMarkdownOverlayProps,
  type ImagePreviewOverlayProps,
  type PDFPreviewOverlayProps,
  ActivityCardsOverlay,
  type ActivityCardsOverlayProps,
} from './components/overlay'

// 文件分类（供链接拦截器使用）
export {
  classifyFile,
  type FilePreviewType,
  type FileClassification,
} from './lib/file-classification'

// Utilities
export { cn } from './lib/utils'
export {
  openExternalUrl,
  type OpenExternalUrlResult,
} from './lib/open-external-url'
export {
  setDismissibleLayerBridge,
  getDismissibleLayerBridge,
  type DismissibleLayerBridge,
  type DismissibleLayerRegistration,
  type DismissibleLayerSnapshot,
  type DismissibleLayerType,
} from './lib/dismissible-layer-bridge'

// 布局常量与 hooks
export {
  CHAT_LAYOUT,
  CHAT_CLASSES,
  OVERLAY_LAYOUT,
  useOverlayMode,
  type OverlayMode,
} from './lib/layout'

// 工具结果解析器
export {
  parseReadResult,
  parseBashResult,
  parseGrepResult,
  parseGlobResult,
  extractOverlayData,
  extractOverlayCards,
  type ReadResult,
  type BashResult,
  type GrepResult,
  type GlobResult,
  type CodeOverlayData,
  type TerminalOverlayData,
  type GenericOverlayData,
  type JSONOverlayData,
  type DocumentOverlayData,
  type OverlayData,
  type OverlayCard,
} from './lib/tool-parsers'

// Turn 工具函数（纯函数）
export * from './components/chat/turn-utils'

// Icons
export {
  Icon_Folder,
  Icon_Home,
  Icon_Inbox,
  type IconProps,
} from './components/icons'
