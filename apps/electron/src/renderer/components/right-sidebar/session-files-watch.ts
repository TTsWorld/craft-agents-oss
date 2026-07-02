/**
 * 会话文件监听恢复助手
 *
 * Electron 渲染进程在断线重连后，可能需要重新注册对当前 session 工作目录的文件监听。
 * 本文件只导出 restoreSessionFileWatch，负责通知主进程恢复监听，然后刷新文件列表。
 */
export async function restoreSessionFileWatch(
  sessionId: string,
  reloadFiles: () => Promise<void>
): Promise<void> {
  try {
    // 通过暴露给渲染进程的 electronAPI，让主进程恢复对该 session 目录的文件监听
    await window.electronAPI.watchSessionFiles(sessionId)
  } catch (error) {
    console.error(`[SessionFiles] Failed to restore file watch for ${sessionId}:`, error)
  }

  try {
    // 监听恢复后重新加载文件树，保证 UI 和磁盘状态一致
    await reloadFiles()
  } catch (error) {
    console.error(`[SessionFiles] Failed to reload files for ${sessionId} after reconnect:`, error)
  }
}
