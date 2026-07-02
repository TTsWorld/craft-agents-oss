/**
 * 统一认证状态管理
 *
 * 提供所有认证状态的单一事实来源：
 * - Billing 配置（api_key 或 oauth_token）
 * - Workspace / MCP 配置
 *
 * 迁移说明（v0.3.0+）：
 * 不再支持从 Claude CLI / Claude Desktop 导入 token。
 * 持有旧版 token 的用户会被提示使用原生 OAuth 重新登录，这是一次性迁移。
 */

import { getCredentialManager } from '../credentials/index.ts';
import {
  loadStoredConfig,
  getActiveWorkspace,
  getDefaultLlmConnection,
  getLlmConnection,
  type AuthType,
  type Workspace,
} from '../config/storage.ts';
import { refreshClaudeToken, isTokenExpired } from './claude-token.ts';
import { debug } from '../utils/debug.ts';

/**
 * 把 config 里的 authType 转成旧的 billing AuthType。
 *
 * `NonNullable<ReturnType<typeof getLlmConnection>>['authType']` 是 TS 类型运算：
 * 先取 getLlmConnection 的返回类型，再去掉 null/undefined，最后取 authType 字段。
 * 类似 Go 里从某个 struct 类型里取一个字段类型。
 */
function toLegacyBillingType(
  authType: NonNullable<ReturnType<typeof getLlmConnection>>['authType'],
): AuthType {
  switch (authType) {
    case 'oauth':
      return 'oauth_token'
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token':
    case 'iam_credentials':
    case 'service_account_file':
    case 'environment':
    case 'none':
      return 'api_key'
  }
}

// ============================================
// 类型定义
// ============================================

/** 迁移提示信息：当用户需要重新登录时返回 */
export interface MigrationInfo {
  reason: 'legacy_token';
  message: string;
}

/** token 校验/刷新操作的结果 */
export interface TokenResult {
  accessToken: string | null;
  migrationRequired?: MigrationInfo;
}

/**
 * 统一认证状态。
 *
 * 与 types.ts 里的 AuthState 类似，但这里多了从本地存储读取的逻辑。
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

  /** Workspace / MCP 配置 */
  workspace: {
    hasWorkspace: boolean;
    active: Workspace | null;
  };
}

/**
 * 根据认证状态判断还需要做哪些初始化步骤。
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

// ============================================
// Token 刷新互斥锁
// ============================================

// 防止并发刷新：一次刷新进行时，其他调用者等待它完成
let refreshInProgress: Promise<TokenResult> | null = null;

/**
 * 实际执行 token 刷新（仅在持有互斥锁时调用）。
 *
 * @param manager - 凭据管理器实例
 * @param refreshToken - 用于刷新的 refresh token
 * @param originalSource - 凭据来源（native / cli / undefined）
 * @param connectionSlug - LLM 连接 slug
 * @returns TokenResult，包含 accessToken 和可选的 migrationRequired
 */
export async function performTokenRefresh(
  manager: ReturnType<typeof getCredentialManager>,
  refreshToken: string,
  originalSource: 'native' | 'cli' | undefined,
  connectionSlug: string
): Promise<TokenResult> {
  try {
    const refreshed = await refreshClaudeToken(refreshToken);

    // 格式化过期时间用于日志
    const expiresAtDate = refreshed.expiresAt ? new Date(refreshed.expiresAt).toISOString() : 'never';
    debug(`[auth] Successfully refreshed Claude OAuth token (expires: ${expiresAtDate})`);

    // 保存新凭据
    // 如果通过原生端点刷新成功，就把 source 标记为 'native'
    //（成功刷新证明兼容我们的 OAuth 系统）
    await manager.setClaudeOAuthCredentials({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      source: 'native',
    });

    // 同时写入 LLM connection（双写，保持向后兼容）
    // 这样旧版和新版的认证路径都能拿到刷新后的 token
    await manager.setLlmOAuth(connectionSlug, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    });

    return { accessToken: refreshed.accessToken };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    debug('[auth] Failed to refresh Claude OAuth token:', errorMessage);

    // 只对明确的 OAuth 错误清除凭据；网络错误、超时、未知错误保持保守
    const isIncompatibleToken =
      errorMessage.includes('invalid_grant') ||
      errorMessage.includes('Refresh token not found or invalid') ||
      errorMessage.includes('invalid_refresh_token');

    let migrationRequired: MigrationInfo | undefined;

    if (isIncompatibleToken) {
      // Token 刷新失败：可能是旧版 CLI token 或已过期/撤销
      debug('[auth] Token refresh failed - credentials will be cleared');

      // 根据存储的 source 判断是否是 CLI 来源
      const isFromCLI = originalSource === 'cli' || !originalSource;
      if (isFromCLI) {
        debug('[auth] Token was from CLI or unknown source - migration required');
        migrationRequired = {
          reason: 'legacy_token',
          message:
            'Your Claude authentication needs to be refreshed. ' +
            'Please sign in again.',
        };
      }

      // 清除不兼容的凭据，强制重新登录
      // 同时从新版和旧版两个位置清除
      await manager.setClaudeOAuthCredentials({
        accessToken: '',
        refreshToken: undefined,
        expiresAt: undefined,
      });

      // 也从 LLM connection 清除（双清，保持一致）
      await manager.deleteLlmCredentials(connectionSlug);
    }

    // 刷新失败：返回 null token 和可选的迁移信息
    return { accessToken: null, migrationRequired };
  }
}

// ============================================
// 函数
// ============================================

/**
 * 获取并必要时刷新 Claude OAuth token。
 *
 * 流程：
 * 1. 检查凭据存储里是否有 token
 * 2. 检测旧版 CLI token 并触发迁移
 * 3. 如果 token 已过期且有 refresh token，则刷新
 * 4. 返回有效的 access token 和可选迁移信息
 *
 * 互斥锁：同一时刻只能有一次刷新。如果刷新已在进行，其他调用者会等待，
 * 然后重新读取凭据。
 *
 * 迁移（v0.3.0+）：
 * - 不再从 Claude CLI keychain 导入 token
 * - 检测到旧版 token 会清除并提示重新登录
 */
export async function getValidClaudeOAuthToken(connectionSlug: string): Promise<TokenResult> {
  const manager = getCredentialManager();

  // 从我们的凭据存储读取
  const creds = await manager.getClaudeOAuthCredentials();

  if (!creds || !creds.accessToken) {
    return { accessToken: null };
  }

  // 检查 token 是否已过期或即将过期
  if (isTokenExpired(creds.expiresAt)) {
    const expiresAtDate = creds.expiresAt ? new Date(creds.expiresAt).toISOString() : 'unknown';
    debug(`[auth] Claude OAuth token expired (was: ${expiresAtDate}), attempting refresh`);

    // 有 refresh token 才尝试刷新
    if (creds.refreshToken) {
      // 如果已经有刷新在进行，等待它完成
      if (refreshInProgress) {
        debug('[auth] Token refresh already in progress, waiting...');
        try {
          await refreshInProgress;
        } catch {
          // 忽略其他刷新尝试的错误
        }
        // 等待后重新读取凭据（可能已被更新）
        const updatedCreds = await manager.getClaudeOAuthCredentials();
        if (updatedCreds?.accessToken && !isTokenExpired(updatedCreds.expiresAt)) {
          const expiresAtDate = updatedCreds.expiresAt ? new Date(updatedCreds.expiresAt).toISOString() : 'never';
          debug(`[auth] Got refreshed token from concurrent refresh (expires: ${expiresAtDate})`);
          return { accessToken: updatedCreds.accessToken };
        }
        // 如果仍然没有有效 token，返回 null（另一个刷新可能已经失败）
        debug('[auth] Concurrent refresh did not produce valid token');
        return { accessToken: null };
      }

      // 启动刷新并设置互斥锁
      debug('[auth] Starting token refresh (holding mutex)');
      refreshInProgress = performTokenRefresh(manager, creds.refreshToken, creds.source, connectionSlug);

      try {
        const result = await refreshInProgress;
        return result;
      } finally {
        // 释放互斥锁
        refreshInProgress = null;
      }
    } else {
      debug('[auth] No refresh token available, cannot refresh expired token');
      return { accessToken: null };
    }
  }

  return { accessToken: creds.accessToken };
}

/**
 * 从所有来源（配置文件 + 凭据存储）获取完整认证状态。
 *
 * 以 LLM connection 作为计费类型和凭据的事实来源，
 * 同时回退到旧版全局凭据以保持向后兼容。
 */
export async function getAuthState(): Promise<AuthState> {
  const config = loadStoredConfig();
  const manager = getCredentialManager();
  const activeWorkspace = getActiveWorkspace();

  // 获取默认 LLM connection 以确定计费类型
  const defaultConnectionSlug = getDefaultLlmConnection();
  const connection = defaultConnectionSlug ? getLlmConnection(defaultConnectionSlug) : null;

  // 从 connection 推导计费类型（没有旧版回退；迁移会确保所有用户都有 connection）
  let effectiveAuthType: AuthType | null = null;
  if (connection) {
    // 任何已配置的默认连接都视为已配置计费，
    // 包括 environment/IAM 认证（Bedrock、Vertex）
    effectiveAuthType = toLegacyBillingType(connection.authType)
  }

  // 根据计费类型和 connection 检查凭据
  let hasCredentials = false;
  let apiKey: string | null = null;
  let claudeOAuthToken: string | null = null;
  let migrationRequired: MigrationInfo | undefined;

  if (connection && defaultConnectionSlug) {
    // 使用 LLM connection 的凭据
    // 传 providerType 用于 OAuth 路由（OpenAI OAuth 需要 idToken）
    hasCredentials = await manager.hasLlmCredentials(defaultConnectionSlug, connection.authType, connection.providerType);

    if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint' || connection.authType === 'bearer_token') {
      apiKey = await manager.getLlmApiKey(defaultConnectionSlug);
      // 无 key  provider（如 Ollama）配置了自定义 baseUrl 也视为有效
      if (!apiKey && connection.baseUrl) {
        hasCredentials = true;
      }
    } else if (connection.authType === 'oauth') {
      const llmOAuth = await manager.getLlmOAuth(defaultConnectionSlug);
      if (llmOAuth?.accessToken) {
        claudeOAuthToken = llmOAuth.accessToken;
      }
    }
    // 其他 authType（iam_credentials、service_account_file、environment、none）由 hasLlmCredentials 处理
    // OpenAI / ChatGPT OAuth 凭据在 PiAgent 自己的认证路径里处理
  } else {
    // 没有配置 connection → 没有凭据
    // 迁移流程本应已经创建了默认 connection
    hasCredentials = false;
  }

  return {
    billing: {
      type: effectiveAuthType,
      hasCredentials,
      apiKey,
      claudeOAuthToken,
      migrationRequired,
    },
    workspace: {
      hasWorkspace: !!activeWorkspace,
      active: activeWorkspace,
    },
  };
}

/**
 * 根据当前认证状态推导还需要哪些初始化步骤。
 */
export function getSetupNeeds(state: AuthState, setupDeferred?: boolean): SetupNeeds {
  // 没有计费类型时需要展示计费选择器
  const needsBillingConfig = state.billing.type === null;

  // 有计费类型但缺凭据时需要展示凭据输入
  const needsCredentials = state.billing.type !== null && !state.billing.hasCredentials;

  return {
    needsBillingConfig,
    needsCredentials,
    // 如果初始化完成，或用户点了“稍后设置”，都视为 fully configured
    isFullyConfigured: (!needsBillingConfig && !needsCredentials) || !!setupDeferred,
    needsMigration: state.billing.migrationRequired,
  };
}

// ============================================
// 测试辅助函数（仅用于测试）
// ============================================

/**
 * 重置刷新互斥锁（仅用于测试）。
 * 让测试可以从干净状态开始。
 */
export function _resetRefreshMutex(): void {
  refreshInProgress = null;
}
