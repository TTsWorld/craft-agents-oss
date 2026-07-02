/**
 * window-state.ts —— 窗口状态持久化。
 *
 * 在应用退出时保存各窗口的位置、大小、工作区、URL 等信息，
 * 下次启动时恢复。文件存放在 ~/.craft-agent/window-state.json。
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'
import { mainLog } from './logger'
import { join } from 'path'
import { homedir } from 'os'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindow {
  type: 'main'
  workspaceId: string
  bounds: WindowBounds
  focused?: boolean
  // 退出时从 webContents.getURL() 捕获的完整 URL。
  // 可能是 dev 的 localhost 或 prod 的 file://，但 createWindow() 不会直接加载它，
  // 而是提取 query 参数（workspaceId、route、focused 等）后重新构造 URL。
  url?: string
}

export interface WindowState {
  windows: SavedWindow[]
  lastFocusedWorkspaceId?: string
}

const CONFIG_DIR = join(homedir(), '.craft-agent')
const WINDOW_STATE_FILE = join(CONFIG_DIR, 'window-state.json')

/**
 * 保存当前窗口状态（位置、大小、类型等）
 */
export function saveWindowState(state: WindowState): void {
  try {
    // 确保配置目录存在
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }

    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
    mainLog.info('[WindowState] Saved window state:', state.windows.length, 'windows')
  } catch (error) {
    mainLog.error('[WindowState] Failed to save window state:', error)
  }
}

/**
 * 加载保存的窗口状态
 */
export function loadWindowState(): WindowState | null {
  try {
    if (!existsSync(WINDOW_STATE_FILE)) {
      return null
    }

    const raw = readJsonFileSync(WINDOW_STATE_FILE)

    // 简单校验格式
    const state = raw as WindowState
    if (!Array.isArray(state.windows)) {
      mainLog.warn('[WindowState] Invalid window state file, ignoring')
      return null
    }

    mainLog.info('[WindowState] Loaded window state:', state.windows.length, 'windows')
    return state
  } catch (error) {
    mainLog.error('[WindowState] Failed to load window state:', error)
    return null
  }
}

/**
 * 清空保存的窗口状态
 */
export function clearWindowState(): void {
  try {
    if (existsSync(WINDOW_STATE_FILE)) {
      writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ windows: [] }, null, 2), 'utf-8')
      mainLog.info('[WindowState] Cleared window state')
    }
  } catch (error) {
    mainLog.error('[WindowState] Failed to clear window state:', error)
  }
}
