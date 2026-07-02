/**
 * 文件：window-manager-interface.ts
 * 位置：packages/server-core/src/handlers
 * 职责：server-core handlers 所需的最小窗口管理器接口 IWindowManager。
 *
 * 架构角色：
 *   - 只声明 handler 需要的能力：window ↔ workspace 映射、注册、查询。
 *   - 具体实现由 Electron 的 WindowManager 提供，通过结构满足接口（duck typing）。
 *   - 类似 Go 中在 handler 层定义小接口，由 Electron 主进程实现。
 *
 * Agent 开发关注点：
 *   - 窗口属于 UI 层；server-core 只关心“这个 webContents 属于哪个 workspace”。
 *   - 多 workspace 场景下，窗口可以在 workspace 之间迁移。
 *
 * TS 特性：
 *   - `unknown` 是比 `any` 更安全的顶层类型，表示“具体类型不确定，使用前必须检查”。
 *     这里 window 对象来自 Electron，但 server-core 不需要知道具体类型，所以用 unknown。
 *   - 注释里提到“推荐显式 implements 但非必须”，这是 TS 结构化类型系统的特点：
 *     只要类的 public 成员形状匹配，就视为兼容。
 */
export interface IWindowManager {
  /** 根据 webContentsId 查找其所属 workspace。 */
  getWorkspaceForWindow(webContentsId: number): string | null

  /** 把窗口移动到另一个 workspace；找不到窗口时返回 false。 */
  updateWindowWorkspace(webContentsId: number, workspaceId: string): boolean

  /** 根据 webContentsId 查找窗口。 */
  getWindowByWebContentsId(webContentsId: number): unknown | null

  /** 为某个 workspace 注册或重新注册一个窗口。 */
  registerWindow(window: unknown, workspaceId: string): void

  /** 获取某个 workspace 下所有被追踪的窗口。 */
  getAllWindowsForWorkspace(workspaceId: string): unknown[]
}
