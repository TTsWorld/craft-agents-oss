/**
 * config-defaults.json 的 TypeScript 类型定义。
 *
 * 真正默认值在 apps/electron/resources/config-defaults.json 里，
 * 这里只描述 JSON 结构，启动时会从 bundled 资源同步到 ~/.craft-agent/。
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';

/** bundled 默认配置的整体结构 */
export interface ConfigDefaults {
  /** 配置版本号，用于升级判断 */
  version: string;
  /** 人类可读描述 */
  description: string;
  /** 应用级默认开关 */
  defaults: {
    /** 是否显示桌面通知 */
    notificationsEnabled: boolean;
    /** 默认颜色主题 ID */
    colorTheme: string;
    /** 输入时是否自动大写首字母 */
    autoCapitalisation: boolean;
    /** 发送消息快捷键：回车 或 cmd+回车 */
    sendMessageKey: 'enter' | 'cmd-enter';
    /** 输入框是否启用拼写检查 */
    spellCheck: boolean;
    /** 运行中是否阻止屏幕休眠 */
    keepAwakeWhileRunning: boolean;
    /** 是否为 tool 调用附带意图/显示名元数据 */
    richToolDescriptions: boolean;
    /** 是否使用 1 小时 prompt cache TTL（默认 5 分钟） */
    extendedPromptCache: boolean;
    /** 是否启用内置 browser tool */
    browserToolEnabled: boolean;
    /**
     * 是否允许远程 Agent 在本地浏览器执行 `browser_tool evaluate <expression>`。
     * 为 false 时本地 dispatcher 会返回 BROWSER_REMOTE_EVALUATE_BLOCKED。
     */
    allowRemoteEvaluate: boolean;
  };
  /** 新建 workspace 时的默认设置 */
  workspaceDefaults: {
    /** 默认思考级别：low / medium / high */
    thinkingLevel: ThinkingLevel;
    /** 默认权限模式：safe / ask / allow-all */
    permissionMode: PermissionMode;
    /** 用户可以在这些权限模式之间循环切换 */
    cyclablePermissionModes: PermissionMode[];
    /** 本地 MCP 服务器总开关 */
    localMcpServers: {
      enabled: boolean;
    };
  };
}
