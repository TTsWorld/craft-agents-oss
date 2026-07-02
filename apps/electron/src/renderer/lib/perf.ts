/**
 * 渲染进程性能打点
 *
 * 跟踪从用户点击会话到渲染完成的耗时。
 * 通过 electron-log 输出到主日志文件。
 *
 * 用法：
 *   // 在 SessionList 点击处理中：
 *   rendererPerf.startSessionSwitch(sessionId)
 *
 *   // 在 ChatTabPanel 会话加载完成时：
 *   rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
 *
 *   // 渲染完成时：
 *   rendererPerf.endSessionSwitch(sessionId)
 */

import log from 'electron-log/renderer'

const perfLog = log.scope('perf')

interface SessionSwitchMetric {
  sessionId: string
  startTime: number
  marks: Array<{ name: string; elapsed: number }>
  endTime?: number
  duration?: number
}

// 正在进行的会话切换（按 sessionId 索引）
const pendingSwitches = new Map<string, SessionSwitchMetric>()

// 最近完成的指标，用于分析
const recentMetrics: SessionSwitchMetric[] = []
const MAX_RECENT_METRICS = 50

// 调试模式开关（与主进程模式保持一致）
let debugMode = false

/**
 * 初始化性能跟踪。应用启动时调用一次。
 * 在 Electron 渲染进程中根据是否处于开发模式开启。
 */
export function initRendererPerf(isDebug: boolean): void {
  debugMode = isDebug
  if (debugMode) {
    perfLog.info('Renderer performance tracking enabled')
  }
}

/**
 * 检查性能跟踪是否已启用
 */
export function isRendererPerfEnabled(): boolean {
  return debugMode
}

/**
 * 开始跟踪一次会话切换。
 * 用户在会话列表中点击会话时调用。
 * 会清空其他 pending 切换（表示用户在完成前就导航走了）。
 */
export function startSessionSwitch(sessionId: string): void {
  if (!debugMode) return

  // 清空其他 pending 切换——用户在完成前又点了别处
  pendingSwitches.clear()

  const metric: SessionSwitchMetric = {
    sessionId,
    startTime: performance.now(),
    marks: [],
  }
  pendingSwitches.set(sessionId, metric)

  // 立即记录一次 0ms 的 tap 点，标记流程起点
  perfLog.info(`${sessionId.slice(0, 8)}... session-list.tap: 0.0ms`)
}

/**
 * 在会话切换过程中添加检查点。
 * 可用于 'session.loaded'、'agent.status' 等中间步骤。
 */
export function markSessionSwitch(sessionId: string, markName: string): void {
  if (!debugMode) return

  const metric = pendingSwitches.get(sessionId)
  if (!metric) return

  const elapsed = performance.now() - metric.startTime
  metric.marks.push({ name: markName, elapsed })

  perfLog.info(`${sessionId.slice(0, 8)}... ${markName}: ${elapsed.toFixed(1)}ms`)
}

/**
 * 结束会话切换跟踪并输出总耗时。
 * 在聊天界面完全渲染后调用。
 */
export function endSessionSwitch(sessionId: string): number | null {
  if (!debugMode) return null

  const metric = pendingSwitches.get(sessionId)
  if (!metric) return null

  metric.endTime = performance.now()
  metric.duration = metric.endTime - metric.startTime

  // 存入最近指标
  recentMetrics.push(metric)
  if (recentMetrics.length > MAX_RECENT_METRICS) {
    recentMetrics.shift()
  }

  // 清理 pending
  pendingSwitches.delete(sessionId)

  // 输出带分阶段的完成日志
  const marksStr = metric.marks.map((m) => `${m.name}:${m.elapsed.toFixed(0)}ms`).join(' → ')
  perfLog.info(
    `Session switch complete: ${metric.duration.toFixed(1)}ms` +
      (marksStr ? ` (${marksStr})` : '')
  )

  return metric.duration
}

/**
 * 获取最近的会话切换指标，用于分析
 */
export function getRecentMetrics(): SessionSwitchMetric[] {
  return [...recentMetrics]
}

/**
 * 获取会话切换耗时的统计信息
 */
export function getSessionSwitchStats(): {
  count: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  minMs: number
  maxMs: number
} | null {
  if (recentMetrics.length === 0) return null

  const durations = recentMetrics
    .filter((m) => m.duration !== undefined)
    .map((m) => m.duration!)

  if (durations.length === 0) return null

  const sorted = [...durations].sort((a, b) => a - b)
  const sum = durations.reduce((a, b) => a + b, 0)

  return {
    count: durations.length,
    avgMs: sum / durations.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

/**
 * 清空所有指标
 */
export function clearMetrics(): void {
  pendingSwitches.clear()
  recentMetrics.length = 0
}

// 以命名空间形式导出，方便使用
export const rendererPerf = {
  init: initRendererPerf,
  isEnabled: isRendererPerfEnabled,
  startSessionSwitch,
  markSessionSwitch,
  endSessionSwitch,
  getRecentMetrics,
  getStats: getSessionSwitchStats,
  clear: clearMetrics,
}

export default rendererPerf
