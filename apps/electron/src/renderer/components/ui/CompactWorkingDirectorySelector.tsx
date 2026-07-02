/**
 * CompactWorkingDirectorySelector — 紧凑模式下的工作目录选择器
 *
 * Working Directory 是 Agent 执行工具时的当前目录（类似 shell 的 cwd）。
 * 这个组件是紧凑/触摸模式下 WorkingDirectoryBadge 的替代方案，
 * 用 Drawer（底部抽屉）代替桌面端的 Popover + cmdk，让每个选项都是全宽点击区。
 * 状态通过与桌面端共用的 useWorkingDirectoryState 管理。
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X, Search } from 'lucide-react'

import { Icon_Home, Icon_Folder } from '@craft-agent/ui'
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from '@/components/ui/drawer'
import { FreeFormInputContextBadge } from '../app-shell/input/FreeFormInputContextBadge'
import { useWorkingDirectoryState } from '../app-shell/input/use-working-directory-state'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { PATH_SEP, getPathBasename } from '@/lib/platform'
import { cn } from '@/lib/utils'

export interface CompactWorkingDirectorySelectorProps {
  /** 当前工作目录路径 */
  workingDirectory?: string
  /** 工作目录变化回调 */
  onWorkingDirectoryChange: (path: string) => void
  /** Session 文件夹路径 */
  sessionFolderPath?: string
  /** 是否为空 Session */
  isEmptySession?: boolean
  /** Workspace ID */
  workspaceId?: string
}

/** 紧凑模式工作目录选择器 */
export function CompactWorkingDirectorySelector({
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  isEmptySession = false,
  workspaceId,
}: CompactWorkingDirectorySelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const closeDrawer = React.useCallback(() => setOpen(false), [])

  const {
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
  } = useWorkingDirectoryState({
    workingDirectory,
    onWorkingDirectoryChange,
    sessionFolderPath,
    workspaceId,
    isOpen: open,
    onClose: closeDrawer,
  })

  // Drawer 内的文本过滤。Hook 只保存原始 filter 字符串；
  // 这里没有 cmdk，所以由组件自己做 JS 过滤。
  const filteredRecent = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sortedRecent
    return sortedRecent.filter((p) => (
      getPathBasename(p).toLowerCase().includes(q) ||
      p.toLowerCase().includes(q)
    ))
  }, [sortedRecent, filter])

  const displayFolderName = folderName ?? t('chat.chooseWorkingDirectory')

  return (
    <>
      <FreeFormInputContextBadge
        icon={<Icon_Home className="h-4 w-4" />}
        label={displayFolderName}
        isExpanded={isEmptySession}
        hasSelection={hasFolder}
        showChevron={true}
        isOpen={open}
        onClick={() => setOpen((prev) => !prev)}
        tooltip={
          hasFolder ? (
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{t('chat.workingDirectory')}</span>
              <span className="text-xs opacity-70">{formatPath(workingDirectory, homeDir)}</span>
              {gitBranch && (
                <span className="text-xs opacity-70">{t('chat.onBranch', { branch: gitBranch })}</span>
              )}
            </span>
          ) : (
            t('chat.chooseWorkingDirectory')
          )
        }
      />

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('chat.workingDirectory')}</DrawerTitle>
          </DrawerHeader>

          {showFilter && (
            <div className="px-4 pb-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground/40 pointer-events-none" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('chat.filterFolders')}
                  className="w-full h-11 pl-10 pr-3 rounded-[10px] bg-foreground/5 text-base outline-none focus:bg-foreground/[0.07] transition-colors"
                />
              </div>
            </div>
          )}

          <div className="px-2 pb-2 flex flex-col gap-0.5 max-h-[50vh] overflow-y-auto">
            {/* 当前目录 — 置顶、不可交互 */}
            {hasFolder && (
              <div className="flex items-center gap-3 px-3 py-3 rounded-[10px] bg-foreground/5">
                <Icon_Folder className="h-5 w-5 shrink-0 text-foreground/60" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{displayFolderName}</div>
                  <div className="text-xs text-foreground/50 truncate">
                    {formatPath(workingDirectory, homeDir)}
                  </div>
                  {gitBranch && (
                    <div className="text-xs text-foreground/50 truncate">
                      {t('chat.onBranch', { branch: gitBranch })}
                    </div>
                  )}
                </div>
                <Check className="h-4 w-4 shrink-0 text-foreground/60" />
              </div>
            )}

            {/* 最近目录 */}
            {filteredRecent.length === 0 && filter.trim() ? (
              <div className="px-4 py-6 text-center text-sm text-foreground/50">
                {t('chat.noFoldersFound')}
              </div>
            ) : (
              filteredRecent.map((path) => {
                const recentFolderName = getPathBasename(path) || 'Folder'
                return (
                  <DrawerClose asChild key={path}>
                    <button
                      type="button"
                      onClick={() => handleSelectRecent(path)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-3 rounded-[10px] text-left transition-colors hover:bg-foreground/5 group/row',
                      )}
                    >
                      <Icon_Folder className="h-5 w-5 shrink-0 text-foreground/60" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{recentFolderName}</div>
                        <div className="text-xs text-foreground/50 truncate">
                          {formatPath(path, homeDir)}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={t('common.remove')}
                        onClick={(e) => handleRemoveRecent(e, path)}
                        className="shrink-0 h-7 w-7 rounded-[6px] flex items-center justify-center text-foreground/30 hover:text-foreground/70 hover:bg-foreground/5 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </button>
                  </DrawerClose>
                )
              })
            )}
          </div>

          {/* 底部操作 — 全宽点击区 */}
          <div className="px-2 pt-2 pb-4 border-t border-border/30 flex flex-col gap-1">
            <button
              type="button"
              onClick={handleChooseFolder}
              className="w-full h-12 px-3 rounded-[10px] flex items-center gap-3 text-sm font-medium hover:bg-foreground/5 transition-colors"
            >
              <Icon_Folder className="h-5 w-5 shrink-0 text-foreground/60" />
              <span>{t('chat.chooseFolder')}</span>
            </button>
            {showReset && (
              <button
                type="button"
                onClick={handleReset}
                className="w-full h-12 px-3 rounded-[10px] flex items-center gap-3 text-sm font-medium text-foreground/70 hover:bg-foreground/5 transition-colors"
              >
                <Icon_Home className="h-5 w-5 shrink-0 text-foreground/60" />
                <span>{t('common.reset')}</span>
              </button>
            )}
          </div>
        </DrawerContent>
      </Drawer>

      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
        initialPath={workingDirectory}
      />
    </>
  )
}

// 本地路径格式化：裸路径（不带 "in " 前缀）。
// 桌面端 badge 的 tooltip 用 "in <path>"；抽屉行单独一行显示路径，再加介词会读起来奇怪。
function formatPath(path: string | undefined, homeDir: string): string {
  if (!path) return ''
  if (homeDir && path.startsWith(homeDir)) {
    const relativePath = path.slice(homeDir.length)
    if (!relativePath || relativePath === PATH_SEP) return '~'
    return '~' + (relativePath.startsWith(PATH_SEP) ? relativePath : PATH_SEP + relativePath)
  }
  return path
}
