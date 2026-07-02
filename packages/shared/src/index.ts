/**
 * @craft-agent/shared
 *
 * Craft Agent 的共享业务逻辑层。
 *
 * 这个包被 Electron 应用、server、CLI 等消费，是除了 @craft-agent/core 类型层之外
 * 最重要的代码包。可以理解为 Golang 项目里的 `internal/` 或 `pkg/` 层：
 * 它包含 Agent 实现、认证、配置、凭证、MCP、Source、Workspace 等全部核心业务逻辑。
 *
 * 推荐通过子路径导入具体模块，而不是从根入口导入所有内容：
 *   import { CraftAgent } from '@craft-agent/shared/agent';
 *   import { loadStoredConfig } from '@craft-agent/shared/config';
 *   import { getCredentialManager } from '@craft-agent/shared/credentials';
 *   import { CraftMcpClient } from '@craft-agent/shared/mcp';
 *
 * 主要模块：
 *   - agent:    CraftAgent SDK 封装、计划工具、权限模式
 *   - auth:     OAuth、token 管理、认证状态
 *   - config:   存储、模型、偏好设置
 *   - credentials: 加密凭证存储
 *   - mcp:      MCP 客户端、连接验证
 *   - prompts:  System prompt 生成
 *   - sources:  Workspace 级别的 source 管理（MCP、API、本地）
 *   - utils:    调试日志、文件处理、摘要
 *   - workspaces: Workspace 管理
 */

// 导出品牌信息（无依赖，可独立使用）
export * from './branding.ts';
