/**
 * Workspace 类型定义
 *
 * Workspace（工作区）是最高层的组织单元。所有资源（source、session 等）都挂在某个 workspace 下。
 *
 * 默认目录结构：
 * ~/.craft-agent/workspaces/{slug}/
 *   ├── config.json      - 工作区配置
 *   ├── sources/         - 数据源（MCP、API、本地文件等）
 *   └── sessions/        - 对话会话
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';

/**
 * 本地 MCP 服务器配置
 *
 * MCP（Model Context Protocol）是 LLM 与外部工具/数据源通信的协议。
 * 本地 MCP 指通过 stdio 启动的子进程服务；该配置决定是否允许创建这种本地服务。
 */
export interface LocalMcpConfig {
  /**
   * 当前 workspace 是否启用本地（stdio）MCP 服务。
   * 若为 false，则只允许使用基于 HTTP 的 MCP 服务。
   * 默认值 true；也可通过环境变量 CRAFT_LOCAL_MCP_ENABLED 覆盖。
   */
  enabled: boolean;
}

/**
 * Workspace 配置（对应磁盘上的 config.json）
 *
 * `interface` 类似 Golang 中的接口，用于描述对象必须有哪些字段。
 */
export interface WorkspaceConfig {
  /** 全局唯一 ID */
  id: string;
  /** 展示名称 */
  name: string;
  /** slug：URL 安全的文件夹名，也是该 workspace 的目录名 */
  slug: string;

  /**
   * 新建 session 时的默认设置。
   * `defaults?:` 表示该对象可选；内部字段也都可以是可选的（`?:`）。
   */
  defaults?: {
    /** 默认使用的模型 */
    model?: string;
    /** 新建 session 默认使用的 LLM 连接（slug），会覆盖全局默认值 */
    defaultLlmConnection?: string;
    /** 默认启用的 source slug 列表 */
    enabledSourceSlugs?: string[];
    /**
     * 默认权限模式（permission mode）：
     * - safe：只允许只读/安全操作；
     * - ask：需要用户确认；
     * - allow-all：允许所有工具调用。
     */
    permissionMode?: PermissionMode;
    /** 可通过 SHIFT+TAB 循环切换的权限模式（至少两种，默认三种） */
    cyclablePermissionModes?: PermissionMode[];
    /** 默认工作目录 */
    workingDirectory?: string;
    /** 新建 session 的默认思考级别（默认 medium） */
    thinkingLevel?: ThinkingLevel;
    /** 当前 workspace 的主题 ID；不设置则继承应用默认主题 */
    colorTheme?: string;
  };

  /**
   * 本地 MCP 服务配置。
   * 优先级：环境变量 CRAFT_LOCAL_MCP_ENABLED > workspace 配置 > 默认 true
   */
  localMcpServers?: LocalMcpConfig;

  /** 创建时间戳（毫秒，同 Golang 中 time.Time.UnixMilli 返回的数值） */
  createdAt: number;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
}

/**
 * 创建 workspace 时传入的参数
 */
export interface CreateWorkspaceInput {
  name: string;
  /** 复用 WorkspaceConfig 中 defaults 的类型定义 */
  defaults?: WorkspaceConfig['defaults'];
}

/**
 * 已加载的 workspace（包含解析后的 source 列表）
 */
export interface LoadedWorkspace {
  config: WorkspaceConfig;
  /** 当前 workspace 下可用的 source slug（仅读取目录名，未完整加载以节省内存） */
  sourceSlugs: string[];
  /** session 数量 */
  sessionCount: number;
}

/**
 * 用于列表展示的 workspace 摘要（轻量）
 */
export interface WorkspaceSummary {
  slug: string;
  name: string;
  sourceCount: number;
  sessionCount: number;
  createdAt: number;
  updatedAt: number;
}
