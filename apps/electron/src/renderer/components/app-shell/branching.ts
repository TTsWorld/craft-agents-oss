/**
 * branching.ts
 *
 * 会话分支（branch）的小工具：决定分支会话是否在新面板中打开。
 * 在 Electron 中，"面板" 类似浏览器标签页/窗口分栏；newPanel 为 true 时在新面板打开分支。
 */

/** resolveBranchNewPanelOption：函数 */
export function resolveBranchNewPanelOption(options?: { newPanel?: boolean }): boolean {
  // 未传选项时默认在新面板打开，保持旧行为
  return options?.newPanel ?? true
}
