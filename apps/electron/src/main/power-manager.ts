/**
 * power-manager.ts —— 电源管理器。
 *
 * 当用户开启「保持屏幕唤醒」且有会话正在处理时，
 * 使用 Electron 的 powerSaveBlocker API 阻止显示器进入睡眠。
 */

import { powerSaveBlocker } from 'electron'
import { mainLog } from './logger'

// 当前电源阻止器的 ID，未阻止时为 null
let powerBlockerId: number | null = null

// 当前正在处理中的会话数量
let activeSessionCount = 0

// 缓存用户设置，避免频繁读配置
let settingEnabled = false

/**
 * 初始化电源管理器：加载当前设置。
 * 在 app 启动时调用。
 */
export async function initPowerManager(): Promise<void> {
  const { getKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
  settingEnabled = getKeepAwakeWhileRunning()
  mainLog.info('[power] Power manager initialized', { settingEnabled })
}

/**
 * 根据活跃会话数和设置更新电源状态。
 * 在以下情况被调用：会话开始/停止处理、设置被切换。
 */
function updatePowerState(): void {
  const shouldBlock = settingEnabled && activeSessionCount > 0

  if (shouldBlock && powerBlockerId === null) {
    // 开始阻止显示器睡眠
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    mainLog.info('[power] Started power save blocker', { blockerId: powerBlockerId, activeSessionCount })
  } else if (!shouldBlock && powerBlockerId !== null) {
    // 停止阻止
    powerSaveBlocker.stop(powerBlockerId)
    mainLog.info('[power] Stopped power save blocker', { blockerId: powerBlockerId })
    powerBlockerId = null
  }
}

/**
 * 会话开始处理时调用。
 */
export function onSessionStarted(): void {
  activeSessionCount++
  mainLog.debug('[power] Session started processing', { activeSessionCount })
  updatePowerState()
}

/**
 * 会话停止处理时调用（完成、出错或取消）。
 */
export function onSessionStopped(): void {
  if (activeSessionCount > 0) {
    activeSessionCount--
  }
  mainLog.debug('[power] Session stopped processing', { activeSessionCount })
  updatePowerState()
}

/**
 * 更新「保持唤醒」设置。
 * 用户切换设置时从 IPC handler 调用。
 */
export function setKeepAwakeSetting(enabled: boolean): void {
  settingEnabled = enabled
  mainLog.info('[power] Keep awake setting changed', { enabled, activeSessionCount })
  updatePowerState()
}

/**
 * 获取当前「保持唤醒」设置值。
 */
export function getKeepAwakeSetting(): boolean {
  return settingEnabled
}

/**
 * 检查电源阻止器当前是否生效，便于调试。
 */
export function isPowerBlockerActive(): boolean {
  return powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)
}

/**
 * 应用退出时清理电源阻止器。
 * Electron 退出时会自动释放，这里显式清理更保险。
 */
export function cleanup(): void {
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId)
    mainLog.info('[power] Cleaned up power save blocker on shutdown')
    powerBlockerId = null
  }
  activeSessionCount = 0
}
