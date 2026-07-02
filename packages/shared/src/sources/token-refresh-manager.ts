/**
 * TokenRefreshManager - 带速率限制的 OAuth token 刷新管理器。
 *
 * 这个类把 token 刷新逻辑单独封装，遵循 SOLID 原则：
 * - 单一职责：只负责刷新调度
 * - 开闭原则：具体刷新委托给 SourceCredentialManager
 * - 依赖倒置：通过构造函数注入 credential manager
 *
 * 速率限制是实例级别的，不是模块级别的，好处：
 * - 可测试（可以创建全新实例）
 * - 会话隔离（每个会话可以有自己的 manager）
 */

import { isRefreshableSource, hasRenewEndpoint, type LoadedSource } from './types.ts';
import type { SourceCredentialManager } from './credential-manager.ts';
import { markSourceAuthenticated } from './storage.ts';

/** 刷新失败后的默认冷却时间：5 分钟 */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export interface TokenRefreshResult {
  /** 是否刷新成功 */
  success: boolean;
  /** 成功时的最新 token */
  token?: string;
  /** 失败原因 */
  reason?: string;
  /** 是否因为速率限制被跳过 */
  rateLimited?: boolean;
}

export interface RefreshManagerOptions {
  /** 刷新失败后的冷却时间（默认 5 分钟） */
  cooldownMs?: number;
  /** 日志函数，用于输出调试信息 */
  log?: (message: string) => void;
}

export class TokenRefreshManager {
  private failedAttempts = new Map<string, number>();
  private cooldownMs: number;
  private log: (message: string) => void;
  private credManager: SourceCredentialManager;

  constructor(
    credManager: SourceCredentialManager,
    options: RefreshManagerOptions = {}
  ) {
    this.credManager = credManager;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.log = options.log ?? (() => {});
  }

  /**
   * 判断某个 source 是否处于最近刷新失败的冷却期。
   */
  isInCooldown(sourceSlug: string): boolean {
    const lastFailure = this.failedAttempts.get(sourceSlug);
    if (!lastFailure) return false;
    return Date.now() - lastFailure < this.cooldownMs;
  }

  /**
   * 记录一次刷新失败，用于速率限制。
   */
  private recordFailure(sourceSlug: string): void {
    this.failedAttempts.set(sourceSlug, Date.now());
  }

  /**
   * 刷新成功时清除失败记录。
   */
  private clearFailure(sourceSlug: string): void {
    this.failedAttempts.delete(sourceSlug);
  }

  /**
   * 清除某个 source 的冷却（例如用户重新认证后）。
   */
  clearCooldown(sourceSlug: string): void {
    this.failedAttempts.delete(sourceSlug);
  }

  /**
   * 重置所有速率限制状态（测试时常用）。
   */
  reset(): void {
    this.failedAttempts.clear();
  }

  /**
   * 判断 source 是否需要刷新 token。
   * token 已过期或即将过期（5 分钟内）返回 true。
   */
  async needsRefresh(source: LoadedSource): Promise<boolean> {
    const cred = await this.credManager.load(source);
    if (!cred) return false;
    // renew-endpoint source 不需要单独 refreshToken —— 用当前 access token 续期
    if (!cred.refreshToken && !hasRenewEndpoint(source)) return false;
    // 没有 expiresAt 就无法判断生命周期， proactively 刷新。
    // 这处理的是早期没有默认 expiresAt 时存的凭证；刷新后新凭证会带上 expiresAt，
    // 之后就不会每次 turn 都刷新了。
    if (!cred.expiresAt) return true;
    return this.credManager.isExpired(cred) || this.credManager.needsRefresh(cred);
  }

  /**
   * 确保 source 有最新 token，需要时自动刷新。
   * 这是 token 刷新的唯一入口（DRY 原则）。
   *
   * @param source - 要刷新的 source
   * @returns 包含成功状态、token 或错误原因的结果
   */
  async ensureFreshToken(source: LoadedSource): Promise<TokenRefreshResult> {
    const slug = source.config.slug;

    // 检查速率限制
    if (this.isInCooldown(slug)) {
      this.log(`[TokenRefresh] Skipping ${slug} - in cooldown after recent failure`);
      return {
        success: false,
        rateLimited: true,
        reason: 'Rate limited after recent failure',
      };
    }

    // 加载凭证并判断是否需要刷新
    const cred = await this.credManager.load(source);

    // 不可刷新的 token（例如 Slack）—— 直接返回现有值。
    // renew-endpoint source 即使没有单独 refreshToken 也可以刷新。
    if (cred && !cred.refreshToken && !hasRenewEndpoint(source)) {
      return { success: true, token: cred.value };
    }

    // 凭证存在、有 expiresAt 且既不过期也不临近过期，直接返回。
    // 没有 expiresAt 表示无法判断生命周期，继续走刷新，让新凭证带上正确的 expiresAt（与 needsRefresh() 逻辑一致）。
    if (cred && cred.expiresAt && !this.credManager.isExpired(cred) && !this.credManager.needsRefresh(cred)) {
      return {
        success: true,
        token: cred.value,
      };
    }

    // 需要刷新
    this.log(`[TokenRefresh] Refreshing token for ${slug}`);

    try {
      const token = await this.credManager.refresh(source);

      if (token) {
        this.log(`[TokenRefresh] Successfully refreshed token for ${slug}`);
        this.clearFailure(slug);

        // 恢复认证状态 —— 抵消启动时 markSourceNeedsReauth() 的影响
        markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
        source.config['isAuthenticated'] = true;
        source.config.connectionStatus = 'connected';
        source.config.connectionError = undefined;

        return { success: true, token };
      } else {
        const reason = 'Refresh returned null';
        this.log(`[TokenRefresh] ${reason} for ${slug}`);
        this.credManager.markSourceNeedsReauth(source, 'Token refresh failed');
        // 把磁盘写入同步到内存状态，使 isSourceUsable() 返回 false，
        // 调用方会把失败 source 从 intendedSlugs 中排除。
        source.config.isAuthenticated = false;
        source.config.connectionStatus = 'needs_auth';
        source.config.connectionError = 'Token refresh failed';
        this.recordFailure(slug);
        return { success: false, reason };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[TokenRefresh] Failed for ${slug}: ${reason}`);
      this.credManager.markSourceNeedsReauth(source, `Refresh error: ${reason}`);
      source.config.isAuthenticated = false;
      source.config.connectionStatus = 'needs_auth';
      source.config.connectionError = `Refresh error: ${reason}`;
      this.recordFailure(slug);
      return { success: false, reason };
    }
  }

  /**
   * 获取所有需要刷新的、可刷新 source。
   * 包含 MCP OAuth、API OAuth（Google、Slack、Microsoft）和 renew-endpoint source。
   * 会过滤掉处于冷却期的 source。
   */
  async getSourcesNeedingRefresh(sources: LoadedSource[]): Promise<LoadedSource[]> {
    // 先过滤出可自动刷新的 source（OAuth + renew-endpoint）
    const refreshableSources = sources.filter(isRefreshableSource);

    if (refreshableSources.length === 0) {
      return [];
    }

    // 并行检查每个 source
    const results = await Promise.all(
      refreshableSources.map(async (source) => {
        // 冷却期中跳过
        if (this.isInCooldown(source.config.slug)) {
          this.log(`[TokenRefresh] Skipping ${source.config.slug} - in cooldown`);
          return { source, needsRefresh: false };
        }

        const needsRefresh = await this.needsRefresh(source);
        return { source, needsRefresh };
      })
    );

    return results
      .filter(({ needsRefresh }) => needsRefresh)
      .map(({ source }) => source);
  }

  /**
   * 并行刷新多个 source。
   * 返回刷新成功的 source 列表和失败的 source 列表。
   */
  async refreshSources(sources: LoadedSource[]): Promise<{
    refreshed: LoadedSource[];
    failed: Array<{ source: LoadedSource; reason: string }>;
  }> {
    const results = await Promise.all(
      sources.map(async (source) => {
        const result = await this.ensureFreshToken(source);
        return { source, result };
      })
    );

    const refreshed: LoadedSource[] = [];
    const failed: Array<{ source: LoadedSource; reason: string }> = [];

    for (const { source, result } of results) {
      if (result.success) {
        refreshed.push(source);
      } else if (!result.rateLimited) {
        failed.push({ source, reason: result.reason || 'Unknown error' });
      }
    }

    return { refreshed, failed };
  }
}

/**
 * 为可刷新的 API source（OAuth 或 renew-endpoint）创建一个取 token 的函数。
 * 这个函数把刷新管理器包装成 server builder 需要的形式。
 */
export function createTokenGetter(
  refreshManager: TokenRefreshManager,
  source: LoadedSource
): () => Promise<string> {
  return async () => {
    const result = await refreshManager.ensureFreshToken(source);
    if (result.success && result.token) {
      return result.token;
    }
    throw new Error(result.reason || `No token for ${source.config.slug}`);
  };
}
