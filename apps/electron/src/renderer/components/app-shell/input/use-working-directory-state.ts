/**
 * use-working-directory-state - 工作目录选择器的状态管理 hook。
 *
 * 同时支撑桌面端 popover（FreeFormInput.WorkingDirectoryBadge）和紧凑端抽屉，
 * 保证两套 UI 的行为不会分叉。
 */
import * as React from 'react'

import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { getPathBasename } from '@/lib/platform'

import {
  addRecentWorkingDir,
  getRecentWorkingDirs,
  removeRecentWorkingDir,
} from './working-directory-history'

/** 超过此阈值时显示过滤输入框 */
export const WORKING_DIR_FILTER_THRESHOLD = 5

/** UseWorkingDirectoryStateInput：hook 输入 */
export interface UseWorkingDirectoryStateInput {
  workingDirectory: string | undefined
  onWorkingDirectoryChange: (path: string) => void
  sessionFolderPath: string | undefined
  workspaceId: string | undefined
  /** 消费方弹层/抽屉是否打开；hook 据此刷新历史记录并重置过滤词 */
  isOpen: boolean
  /** hook 想让消费方关闭时调用（选择最近项、重置、选择文件夹后） */
  onClose: () => void
}

type ServerBrowserBridge = ReturnType<typeof useDirectoryPicker>

/** UseWorkingDirectoryStateResult：hook 输出 */
export interface UseWorkingDirectoryStateResult {
  recentDirs: string[]
  homeDir: string
  gitBranch: string | null
  filter: string
  setFilter: (next: string) => void

  /** 排除当前目录后按 basename 字母排序的最近目录 */
  sortedRecent: string[]
  /** 当前是否选中了非会话根目录的文件夹 */
  hasFolder: boolean
  /** 触发徽章上显示的文件夹名；未选择时为 undefined（消费方自己处理本地化回退） */
  folderName: string | undefined
  /** 是否显示“重置”操作 */
  showReset: boolean
  /** 是否显示搜索/过滤输入框（sortedRecent 超过阈值时为 true） */
  showFilter: boolean

  handleSelectRecent: (path: string) => void
  handleReset: () => void
  handleRemoveRecent: (e: React.MouseEvent, path: string) => void
  handleChooseFolder: () => void

  serverBrowser: Pick<
    ServerBrowserBridge,
    'showServerBrowser' | 'serverBrowserMode' | 'cancelServerBrowser' | 'confirmServerBrowser'
  >
}

/**
 * useWorkingDirectoryState - 工作目录选择器的共享状态机。
 *
 * 同时支撑桌面端 popover 和紧凑端抽屉，避免两套 UI 行为不一致。
 * hook 负责：最近目录列表、home 目录、git 分支获取、过滤输入状态、所有修改回调。
 * hook 不负责：弹层打开状态、自动聚焦、路径显示格式——这些有意留在消费方，因为不同表面需求不同。
 */
export function useWorkingDirectoryState(
  input: UseWorkingDirectoryStateInput,
): UseWorkingDirectoryStateResult {
  const {
    workingDirectory,
    onWorkingDirectoryChange,
    sessionFolderPath,
    workspaceId,
    isOpen,
    onClose,
  } = input

  const [recentDirs, setRecentDirs] = React.useState<string[]>([])
  const [homeDir, setHomeDir] = React.useState<string>('')
  const [gitBranch, setGitBranch] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState('')

  // workspaceId 变化时刷新最近目录和 home 目录
  React.useEffect(() => {
    setRecentDirs(getRecentWorkingDirs(workspaceId))
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir)
    })
  }, [workspaceId])

  // 当前工作目录变化时获取 git 分支
  React.useEffect(() => {
    if (workingDirectory) {
      window.electronAPI?.getGitBranch?.(workingDirectory).then((branch: string | null) => {
        setGitBranch(branch)
      })
    } else {
      setGitBranch(null)
    }
  }, [workingDirectory])

  // 弹层打开时清空过滤并刷新最近目录
  React.useEffect(() => {
    if (isOpen) {
      setFilter('')
      setRecentDirs(getRecentWorkingDirs(workspaceId))
    }
  }, [isOpen, workspaceId])

  const handleFolderSelected = React.useCallback((selectedPath: string) => {
    setRecentDirs(addRecentWorkingDir(selectedPath, workspaceId))
    onWorkingDirectoryChange(selectedPath)
  }, [onWorkingDirectoryChange, workspaceId])

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(handleFolderSelected)

  const handleSelectRecent = React.useCallback((path: string) => {
    setRecentDirs(addRecentWorkingDir(path, workspaceId))
    onWorkingDirectoryChange(path)
    onClose()
  }, [onWorkingDirectoryChange, onClose, workspaceId])

  const handleReset = React.useCallback(() => {
    if (sessionFolderPath) {
      onWorkingDirectoryChange(sessionFolderPath)
      onClose()
    }
  }, [onWorkingDirectoryChange, onClose, sessionFolderPath])

  const handleRemoveRecent = React.useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    setRecentDirs(removeRecentWorkingDir(path, workspaceId))
  }, [workspaceId])

  const handleChooseFolder = React.useCallback(() => {
    onClose()
    pickDirectory()
  }, [onClose, pickDirectory])

  const sortedRecent = React.useMemo(
    () => deriveSortedRecent(recentDirs, workingDirectory),
    [recentDirs, workingDirectory],
  )

  const { hasFolder, folderName, showReset } = React.useMemo(
    () => deriveSelectionFlags(workingDirectory, sessionFolderPath),
    [workingDirectory, sessionFolderPath],
  )

  const showFilter = sortedRecent.length > WORKING_DIR_FILTER_THRESHOLD

  return {
    recentDirs,
    homeDir,
    gitBranch,
    filter,
    setFilter,
    sortedRecent,
    hasFolder,
    folderName,
    showReset,
    showFilter,
    handleSelectRecent,
    handleReset,
    handleRemoveRecent,
    handleChooseFolder,
    serverBrowser: {
      showServerBrowser,
      serverBrowserMode,
      cancelServerBrowser,
      confirmServerBrowser,
    },
  }
}

// —— 纯函数辅助（导出方便测试） ——

/**
 * 过滤掉当前目录并按 basename 字母排序。
 * 纯派生函数；UI 层用它渲染最近文件夹列表。
 */
export function deriveSortedRecent(
  recentDirs: readonly string[],
  workingDirectory: string | undefined,
): string[] {
  return recentDirs
    .filter((p) => p !== workingDirectory)
    .slice()
    .sort((a, b) => {
      const nameA = getPathBasename(a).toLowerCase()
      const nameB = getPathBasename(b).toLowerCase()
      return nameA.localeCompare(nameB)
    })
}

/** SelectionFlags：选择状态标志 */
export interface SelectionFlags {
  hasFolder: boolean
  /** 选中文件夹的 basename；未选择时为 undefined */
  folderName: string | undefined
  showReset: boolean
}

/**
 * 派生触发徽章需要的选择状态标志。
 * “未选择文件夹”意味着要么没有 workingDirectory，要么 workingDirectory 等于会话根目录。
 */
export function deriveSelectionFlags(
  workingDirectory: string | undefined,
  sessionFolderPath: string | undefined,
): SelectionFlags {
  const hasFolder = !!workingDirectory && workingDirectory !== sessionFolderPath
  const folderName = hasFolder
    ? (getPathBasename(workingDirectory!) || undefined)
    : undefined
  const showReset = hasFolder
    && !!sessionFolderPath
    && sessionFolderPath !== workingDirectory
  return { hasFolder, folderName, showReset }
}
