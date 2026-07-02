/**
 * workspaces 模块入口
 *
 * 重新导出 workspace 相关的类型定义与存储操作函数。
 * 其他模块通过 `import { ... } from './workspaces'` 即可使用这些 API。
 */

// 类型定义
export type {
  WorkspaceConfig,
  CreateWorkspaceInput,
  LoadedWorkspace,
  WorkspaceSummary,
} from './types.ts';

// 存储操作函数
export {
  // 路径工具
  getDefaultWorkspacesDir,
  ensureDefaultWorkspacesDir,
  getWorkspacePath,
  getWorkspaceSourcesPath,
  getWorkspaceSessionsPath,
  getWorkspaceSkillsPath,
  // 配置操作
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  // 加载操作
  loadWorkspace,
  getWorkspaceSummary,
  // 创建/删除操作
  generateSlug,
  generateUniqueWorkspacePath,
  createWorkspaceAtPath,
  deleteWorkspaceFolder,
  isValidWorkspace,
  renameWorkspaceFolder,
  // 自动发现
  discoverWorkspacesInDefaultLocation,
  // 常量
  CONFIG_DIR,
  DEFAULT_WORKSPACES_DIR,
} from './storage.ts';
