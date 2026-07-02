/**
 * 凭证管理器（Credential Manager）
 *
 * 凭证存储的主入口。使用加密文件存储，保证跨平台兼容，
 * 且不需要操作系统 keychain 弹窗。
 */

import type { CredentialBackend } from './backends/types.ts';
import type { CredentialId, CredentialType, StoredCredential, CredentialHealthStatus, CredentialHealthIssue } from './types.ts';
import type { LlmAuthType, LlmProviderType } from '../config/llm-connections.ts';
import { SecureStorageBackend } from './backends/secure-storage.ts';
import { debug } from '../utils/debug.ts';

/**
 * CredentialManager 是凭证操作的统一入口。
 * 它管理多个 CredentialBackend，按优先级选择可用后端。
 */
export class CredentialManager {
  private backends: CredentialBackend[] = [];
  private writeBackend: CredentialBackend | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * 显式初始化凭证管理器。
   * 这是可选的——所有公共方法都会通过 ensureInitialized() 自动初始化。
   * 如果希望在应用启动时就完成初始化，可以主动调用这个方法。
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * 内部方法：确保已完成初始化。
   * 所有公共方法都会自动调用它。
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // 防止并发初始化导致竞态条件
    if (this.initPromise) {
      return this.initPromise;
    }

    // 初始化失败时清空 initPromise，允许重试
    this.initPromise = this._doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  private ensureInitializedSync(): void {
    if (this.initialized) {
      return;
    }

    // SecureStorageBackend 永远可用，并且目前是唯一后端。
    // 这个同步路径供 saveSourceConfig() 等同步调用方使用，
    // 避免 fire-and-forget 的清理和立即重新加载之间产生竞态。
    const backend = new SecureStorageBackend();
    this.backends = [backend];
    this.writeBackend = backend;
    this.initialized = true;
    this.initPromise = null;
    debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
    debug(`[CredentialManager] Using backend: ${backend.name}`);
  }

  private async _doInitialize(): Promise<void> {
    const potentialBackends: CredentialBackend[] = [
      new SecureStorageBackend(),
    ];
    const availableBackends: CredentialBackend[] = [];

    // 检查哪些后端可用
    for (const backend of potentialBackends) {
      if (await backend.isAvailable()) {
        availableBackends.push(backend);
        debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
      }
    }

    // 上面的异步可用性检查期间，同步调用方可能已经完成单例初始化。
    // 这种情况下保持同步状态，避免追加重复后端。
    if (this.initialized) return;

    // 按优先级从高到低排序
    availableBackends.sort((a, b) => b.priority - a.priority);
    this.backends = availableBackends;

    // 用第一个可用后端作为写入后端
    this.writeBackend = this.backends[0] || null;

    if (this.writeBackend) {
      debug(`[CredentialManager] Using backend: ${this.writeBackend.name}`);
    } else {
      debug(`[CredentialManager] WARNING: No backend available.`);
    }

    this.initialized = true;
  }

  /** 获取当前用于写入的后端名称 */
  getActiveBackendName(): string | null {
    return this.writeBackend?.name || null;
  }

  /**
   * 根据 ID 获取凭证，会依次尝试所有后端。
   * 需要时自动初始化。
   */
  async get(id: CredentialId): Promise<StoredCredential | null> {
    await this.ensureInitialized();

    for (const backend of this.backends) {
      try {
        const cred = await backend.get(id);
        if (cred) {
          debug(`[CredentialManager] Found ${id.type} in ${backend.name}`);
          return cred;
        }
      } catch (err) {
        debug(`[CredentialManager] Error reading from ${backend.name}:`, err);
      }
    }

    return null;
  }

  /**
   * 使用写入后端设置凭证。
   * 需要时自动初始化。
   */
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.ensureInitialized();

    if (!this.writeBackend) {
      throw new Error('No writable credential backend available');
    }

    await this.writeBackend.set(id, credential);
    debug(`[CredentialManager] Saved ${id.type} to ${this.writeBackend.name}`);
  }

  /**
   * 从所有后端删除凭证。
   * 需要时自动初始化。
   */
  async delete(id: CredentialId): Promise<boolean> {
    await this.ensureInitialized();

    let deleted = false;
    for (const backend of this.backends) {
      try {
        if (await backend.delete(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    return deleted;
  }

  deleteSync(id: CredentialId): boolean {
    this.ensureInitializedSync();

    let deleted = false;
    for (const backend of this.backends) {
      if (!backend.deleteSync) {
        debug(`[CredentialManager] Backend ${backend.name} does not support synchronous delete`);
        continue;
      }

      try {
        if (backend.deleteSync(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    return deleted;
  }

  /**
   * 列出符合过滤条件的凭证。
   * 需要时自动初始化。
   */
  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await this.ensureInitialized();

    const seen = new Set<string>();
    const results: CredentialId[] = [];

    for (const backend of this.backends) {
      try {
        const ids = await backend.list(filter);
        for (const id of ids) {
          const key = JSON.stringify(id);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(id);
          }
        }
      } catch (err) {
        debug(`[CredentialManager] Error listing from ${backend.name}:`, err);
      }
    }

    return results;
  }

  // ============================================================
  // 便捷方法
  // ============================================================

  /** 获取 Anthropic API key */
  async getApiKey(): Promise<string | null> {
    const cred = await this.get({ type: 'anthropic_api_key' });
    return cred?.value || null;
  }

  /** 设置 Anthropic API key */
  async setApiKey(key: string): Promise<void> {
    await this.set({ type: 'anthropic_api_key' }, { value: key });
  }

  /** 获取 Claude OAuth token */
  async getClaudeOAuth(): Promise<string | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    return cred?.value || null;
  }

  /** 设置 Claude OAuth token */
  async setClaudeOAuth(token: string): Promise<void> {
    await this.set({ type: 'claude_oauth' }, { value: token });
  }

  /** 获取 Claude OAuth 完整凭证（含 refresh token、过期时间和来源） */
  async getClaudeOAuthCredentials(): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** token 来源：'native'（我们自己的 OAuth）、'cli'（Claude CLI 导入），或 undefined（未知） */
    source?: 'native' | 'cli';
  } | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    if (!cred) return null;

    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      source: cred.source as 'native' | 'cli' | undefined,
    };
  }

  /** 设置 Claude OAuth 完整凭证（含 refresh token、过期时间和来源） */
  async setClaudeOAuthCredentials(credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** token 来源：'native'（我们自己的 OAuth）、'cli'（Claude CLI 导入） */
    source?: 'native' | 'cli';
  }): Promise<void> {
    await this.set({ type: 'claude_oauth' }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      source: credentials.source,
    });
  }

  /** 获取 Workspace MCP OAuth 凭证 */
  async getWorkspaceOAuth(workspaceId: string): Promise<{
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  } | null> {
    const cred = await this.get({ type: 'workspace_oauth', workspaceId });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      tokenType: cred.tokenType,
      clientId: cred.clientId,
    };
  }

  /** 设置 Workspace MCP OAuth 凭证 */
  async setWorkspaceOAuth(workspaceId: string, credentials: {
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  }): Promise<void> {
    await this.set(
      { type: 'workspace_oauth', workspaceId },
      {
        value: credentials.accessToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
      }
    );
  }

  /** 删除某个 workspace 下的所有 source 凭证 */
  async deleteWorkspaceCredentials(workspaceId: string): Promise<void> {
    const allCreds = await this.list({ workspaceId });
    for (const cred of allCreds) {
      await this.delete(cred);
    }
  }

  // 注意：OpenAI API key 相关方法已移除——Codex 使用原生 ChatGPT OAuth 流程

  // ============================================================
  // LLM 连接凭证
  // ============================================================

  /**
   * 获取 LLM 连接的 API key。
   * @param connectionSlug - 连接标识（slug）
   * @returns API key，找不到则返回 null
   */
  async getLlmApiKey(connectionSlug: string): Promise<string | null> {
    const cred = await this.get({ type: 'llm_api_key', connectionSlug });
    return cred?.value || null;
  }

  /**
   * 设置 LLM 连接的 API key。
   * @param connectionSlug - 连接标识（slug）
   * @param apiKey - 要存储的 API key
   */
  async setLlmApiKey(connectionSlug: string, apiKey: string): Promise<void> {
    await this.set({ type: 'llm_api_key', connectionSlug }, { value: apiKey });
  }

  /**
   * 删除 LLM 连接的 API key。
   * @param connectionSlug - 连接标识（slug）
   * @returns 删除成功返回 true，找不到返回 false
   */
  async deleteLlmApiKey(connectionSlug: string): Promise<boolean> {
    return this.delete({ type: 'llm_api_key', connectionSlug });
  }

  /**
   * 获取 LLM 连接的 OAuth token。
   * @param connectionSlug - 连接标识（slug）
   * @returns OAuth 凭证，找不到返回 null
   */
  async getLlmOAuth(connectionSlug: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token（OpenAI/Codex 使用） */
    idToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_oauth', connectionSlug });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      idToken: cred.idToken,
    };
  }

  /**
   * 设置 LLM 连接的 OAuth token。
   * @param connectionSlug - 连接标识（slug）
   * @param credentials - 要存储的 OAuth 凭证
   */
  async setLlmOAuth(connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token（OpenAI/Codex 使用） */
    idToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_oauth', connectionSlug }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      idToken: credentials.idToken,
    });
  }

  /**
   * 删除某个 LLM 连接的所有凭证。
   * @param connectionSlug - 连接标识（slug）
   */
  async deleteLlmCredentials(connectionSlug: string): Promise<void> {
    await this.delete({ type: 'llm_api_key', connectionSlug });
    await this.delete({ type: 'llm_oauth', connectionSlug });
    await this.delete({ type: 'llm_iam', connectionSlug });
    await this.delete({ type: 'llm_service_account', connectionSlug });
  }

  // ============================================================
  // IAM 凭证（AWS Bedrock）
  // ============================================================

  /**
   * 获取 LLM 连接的 IAM 凭证。
   * @param connectionSlug - 连接标识（slug）
   * @returns IAM 凭证，找不到返回 null
   */
  async getLlmIamCredentials(connectionSlug: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_iam', connectionSlug });
    if (!cred || !cred.awsAccessKeyId) return null;
    return {
      accessKeyId: cred.awsAccessKeyId,
      secretAccessKey: cred.value, // secret key 存在 value 字段
      region: cred.awsRegion,
      sessionToken: cred.awsSessionToken,
    };
  }

  /**
   * 设置 LLM 连接的 IAM 凭证。
   * @param connectionSlug - 连接标识（slug）
   * @param credentials - 要存储的 IAM 凭证
   */
  async setLlmIamCredentials(connectionSlug: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_iam', connectionSlug }, {
      value: credentials.secretAccessKey, // 主 secret 存 value
      awsAccessKeyId: credentials.accessKeyId,
      awsRegion: credentials.region,
      awsSessionToken: credentials.sessionToken,
    });
  }

  // ============================================================
  // 服务账号凭证（GCP Vertex）
  // ============================================================

  /**
   * 获取 LLM 连接的服务账号凭证。
   * @param connectionSlug - 连接标识（slug）
   * @returns 服务账号 JSON 和元数据，找不到返回 null
   */
  async getLlmServiceAccount(connectionSlug: string): Promise<{
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_service_account', connectionSlug });
    if (!cred) return null;
    return {
      serviceAccountJson: cred.value, // 完整 JSON 存在 value 字段
      projectId: cred.gcpProjectId,
      region: cred.gcpRegion,
      email: cred.serviceAccountEmail,
    };
  }

  /**
   * 设置 LLM 连接的服务账号凭证。
   * @param connectionSlug - 连接标识（slug）
   * @param credentials - 要存储的服务账号凭证
   */
  async setLlmServiceAccount(connectionSlug: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_service_account', connectionSlug }, {
      value: credentials.serviceAccountJson, // 完整 JSON 存 value
      gcpProjectId: credentials.projectId,
      gcpRegion: credentials.region,
      serviceAccountEmail: credentials.email,
    });
  }

  // ============================================================
  // 统一凭证检查
  // ============================================================

  /**
   * 检查 LLM 连接是否拥有有效凭证。
   * 使用新的 LlmAuthType 体系——按认证机制路由。
   *
   * @param connectionSlug - 连接标识（slug）
   * @param authType - 要检查的认证类型
   * @param providerType - 可选的提供商类型，用于 OAuth 路由
   * @returns 凭证存在且有效时返回 true
   */
  async hasLlmCredentials(
    connectionSlug: string,
    authType: LlmAuthType,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    switch (authType) {
      // 不需要凭证
      case 'none':
      case 'environment':
        return true;

      // API key 类认证都走同一存储
      case 'api_key':
      case 'api_key_with_endpoint':
      case 'bearer_token':
        return this.hasLlmApiKeyCredential(connectionSlug);

      // OAuth ——浏览器授权流程
      case 'oauth':
        return this.hasLlmOAuthCredential(connectionSlug, providerType);

      // AWS IAM 凭证
      case 'iam_credentials':
        return this.hasLlmIamCredential(connectionSlug);

      // GCP 服务账号
      case 'service_account_file':
        return this.hasLlmServiceAccountCredential(connectionSlug);

      default:
        // 穷尽检查——如果漏了某个 case，TypeScript 会报错
        const _exhaustive: never = authType;
        return false;
    }
  }

  /**
   * 检查连接是否有有效的 API key 凭证。
   * @internal 内部方法
   */
  private async hasLlmApiKeyCredential(connectionSlug: string): Promise<boolean> {
    const apiKey = await this.getLlmApiKey(connectionSlug);
    return !!apiKey;
  }

  /**
   * 检查连接是否有有效的 OAuth 凭证。
   * @internal 内部方法
   */
  private async hasLlmOAuthCredential(
    connectionSlug: string,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    const oauth = await this.getLlmOAuth(connectionSlug);
    if (!oauth) return false;

    // 检查是否过期
    if (oauth.expiresAt && this.isExpired({ value: oauth.accessToken, expiresAt: oauth.expiresAt })) {
      return !!oauth.refreshToken; // 有 refresh token 就可以刷新
    }
    return true;
  }

  /**
   * 检查连接是否有有效的 IAM 凭证。
   * @internal 内部方法
   */
  private async hasLlmIamCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmIamCredentials(connectionSlug);
    return !!cred?.accessKeyId && !!cred?.secretAccessKey;
  }

  /**
   * 检查连接是否有有效的服务账号凭证。
   * @internal 内部方法
   */
  private async hasLlmServiceAccountCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmServiceAccount(connectionSlug);
    return !!cred?.serviceAccountJson;
  }

  /**
   * 判断凭证是否已过期（预留 5 分钟缓冲）。
   *
   * 如果未设置 expiresAt：
   * - OAuth token（有 refreshToken）：视为已过期，强制尝试刷新
   * - API key（没有 refreshToken）：视为永不过期
   *
   * 这样可以防止某些提供商没返回 expires_in 时，OAuth token 被当成永久有效。
   */
  isExpired(credential: StoredCredential): boolean {
    if (credential.expiresAt) {
      // 离过期还有 5 分钟内就认为已过期
      return Date.now() > credential.expiresAt - 5 * 60 * 1000;
    }

    // 没有 expiresAt 时，根据凭证类型决定行为
    if (credential.refreshToken) {
      // OAuth token 没有过期时间——当作已过期，强制刷新
      // 这比假设它永久有效更安全
      debug('[CredentialManager] OAuth token missing expiresAt - treating as expired');
      return true;
    }

    // 没有过期时间的 API key——通常不会过期
    return false;
  }

  // ============================================================
  // 健康检查
  // ============================================================

  /**
   * 检查凭证仓库的健康状态。
   *
   * 会验证：
   * 1. 凭证文件能否读取并解密（如果存在）
   * 2. 默认 LLM 连接是否有有效凭证
   *
   * 应用启动时调用它，可以提前发现问题，而不是等用户遇到晦涩错误。
   *
   * @returns 健康状态及发现的问题
   */
  async checkHealth(): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];

    try {
      await this.ensureInitialized();

      // 1. 尝试列出凭证——这会触发解密
      // 如果文件损坏或无法解密，会抛错
      await this.list({});

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const lowerMsg = errorMsg.toLowerCase();

      // 判断是否为解密失败（通常是换机器迁移）
      if (lowerMsg.includes('decrypt') || lowerMsg.includes('cipher') || lowerMsg.includes('authentication tag')) {
        issues.push({
          type: 'decryption_failed',
          message: 'Credentials from another machine detected. Please re-authenticate.',
          error: errorMsg,
        });
      } else if (lowerMsg.includes('json') || lowerMsg.includes('parse') || lowerMsg.includes('unexpected')) {
        issues.push({
          type: 'file_corrupted',
          message: 'Credential file is corrupted. Please re-authenticate.',
          error: errorMsg,
        });
      } else {
        // 未知错误，按文件损坏处理
        issues.push({
          type: 'file_corrupted',
          message: 'Failed to read credentials. Please re-authenticate.',
          error: errorMsg,
        });
      }

      return { healthy: false, issues };
    }

    // 2. 检查默认连接是否有凭证
    // 延迟导入，避免循环依赖
    try {
      const { getDefaultLlmConnection, getLlmConnection } = await import('../config/storage.ts');
      const defaultSlug = getDefaultLlmConnection();

      if (defaultSlug) {
        const connection = getLlmConnection(defaultSlug);
        if (connection && connection.authType !== 'none' && connection.authType !== 'environment') {
          const hasCredentials = await this.hasLlmCredentials(
            defaultSlug,
            connection.authType,
            connection.providerType
          );
          if (!hasCredentials) {
            issues.push({
              type: 'no_default_credentials',
              message: `No credentials found for default connection "${connection.name}".`,
            });
          }
        }
      }
    } catch (configError) {
      // 配置尚未初始化，跳过这项检查
      debug('[CredentialManager] Skipping default connection check - config not available');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}

// 单例实例
let manager: CredentialManager | null = null;

/** 获取 CredentialManager 单例，类似 Golang 中一个包级变量加同步初始化 */
export function getCredentialManager(): CredentialManager {
  if (!manager) {
    manager = new CredentialManager();
  }
  return manager;
}
