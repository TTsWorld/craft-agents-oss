/**
 * 认证相关类型（浏览器安全）
 *
 * 这里只放纯类型定义，没有运行时依赖，可以被浏览器端打包使用。
 * TypeScript 的 type/interface 在编译后会被擦除，不会增加运行时体积。
 */

import type { AuthType, Workspace } from '../config/types.ts';

/**
 * 迁移提示信息：当用户持有旧版 token 需要重新登录时返回。
 * reason 固定为 'legacy_token'，message 用于展示给用户。
 */
export interface MigrationInfo {
  reason: 'legacy_token';
  message: string;
}

/**
 * 统一认证状态
 *
 * 包含两块：
 * 1. billing：大模型 API 的计费/鉴权方式（api_key 还是 oauth_token）。
 * 2. workspace：当前工作区 / MCP 配置。
 */
export interface AuthState {
  /** Claude API 计费配置 */
  billing: {
    /** 当前配置的计费类型，未配置时为 null */
    type: AuthType | null;
    /** 是否已拥有当前计费类型所需的凭据 */
    hasCredentials: boolean;
    /** Anthropic API key（authType 为 api_key 时使用） */
    apiKey: string | null;
    /** Claude Max OAuth token（authType 为 oauth_token 时使用） */
    claudeOAuthToken: string | null;
    /** 如果需要重新登录，则带上迁移信息 */
    migrationRequired?: MigrationInfo;
  };

  /** 工作区 / MCP 配置 */
  workspace: {
    hasWorkspace: boolean;
    active: Workspace | null;
  };
}

/**
 * 根据当前认证状态判断还需要做哪些初始化步骤。
 * 对 Go 同学来说，可以把它理解成一个用于驱动 UI 的状态结构体。
 */
export interface SetupNeeds {
  /** 还没选计费类型 → 展示计费选择器 */
  needsBillingConfig: boolean;
  /** 已选计费类型但缺少凭据 → 展示凭据输入 */
  needsCredentials: boolean;
  /** 全部完成 → 直接进入应用 */
  isFullyConfigured: boolean;
  /** 用户持有旧版 token，需要重新登录 */
  needsMigration?: MigrationInfo;
}

/**
 * OAuth 流程中的会话上下文。
 *
 * 用途：OAuth 完成后通过 deeplink 把用户带回当前聊天 session。
 * 对 Agent 初学者来说，session 就是一次正在进行的对话上下文。
 */
export interface OAuthSessionContext {
  /** OAuth 完成后要返回的 session ID */
  sessionId?: string;
  /** 应用的 deeplink scheme，例如 'craftagents' */
  deeplinkScheme?: string;
}

/**
 * 构造 OAuth 完成后的 deeplink URL，用于跳回聊天 session。
 *
 * @param ctx - 会话上下文，包含 sessionId 和 deeplinkScheme
 * @returns 跳转 URL；如果上下文不完整则返回 undefined
 *
 * `ctx?.sessionId` 这种写法叫“可选链”：
 * 当 ctx 为 undefined/null 时不会报错，直接返回 undefined，类似 Go 中的短路与判断。
 */
export function buildOAuthDeeplinkUrl(ctx?: OAuthSessionContext): string | undefined {
  if (!ctx?.sessionId || !ctx?.deeplinkScheme) return undefined;
  return `${ctx.deeplinkScheme}://allSessions/session/${ctx.sessionId}`;
}
