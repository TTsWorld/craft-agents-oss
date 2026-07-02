/**
 * OAuthFlowStore —— 待处理 OAuth 流程的内存存储。
 *
 * 仅存于服务端，不会序列化，也不会发给客户端。
 * 用 state（CSRF token）作为 key，O(1) 查找。
 * 5 分钟 TTL，支持惰性清理 + 定时清理。
 */

import type { LoadedSource } from '../sources/types.ts';
import type { OAuthProvider } from './oauth-flow-types.ts';

/** 流程存活时间：5 分钟 */
const FLOW_TTL_MS = 5 * 60 * 1000;
/** 清理周期：每分钟扫一次过期项 */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * 一个待处理的 OAuth 流程。
 * 保存了 prepare 阶段生成的所有信息，以及用于校验的绑定字段。
 */
export interface PendingOAuthFlow {
  flowId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  source: LoadedSource;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  provider: OAuthProvider;

  // 绑定字段：oauth:complete 阶段会校验，防止 A 用户/工作区拿到 B 用户的 state
  ownerClientId: string;
  workspaceId: string;
  sourceSlug: string;

  // 可选：从认证请求卡片发起时绑定的 session
  sessionId?: string;
  authRequestId?: string;

  createdAt: number;
  expiresAt: number;
}

/**
 * OAuth 流程内存存储类。
 * 对 Go 同学来说，相当于一个带 TTL 的内存 map + 后台清理 goroutine。
 */
export class OAuthFlowStore {
  // 用 Map 存储 state → PendingOAuthFlow；state 是 CSRF token
  private flows = new Map<string, PendingOAuthFlow>();
  // 定时清理器；ReturnType<typeof setInterval> 是 TS 里获取 setInterval 返回类型的写法
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** 写入一个待处理流程 */
  store(flow: PendingOAuthFlow): void {
    this.flows.set(flow.state, flow);
  }

  /** 根据 state 读取流程；如果已过期则删除并返回 null */
  getByState(state: string): PendingOAuthFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;

    // 惰性检查：访问时如果过期就删掉
    if (Date.now() > flow.expiresAt) {
      this.flows.delete(state);
      return null;
    }

    return flow;
  }

  /** 删除指定 state 的流程 */
  remove(state: string): void {
    this.flows.delete(state);
  }

  /** 清理所有过期条目：由定时器触发，也会在访问时惰性执行 */
  cleanup(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) {
      if (now > flow.expiresAt) {
        this.flows.delete(state);
      }
    }
  }

  /** 停止定时清理器（优雅退出时使用） */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.flows.clear();
  }

  /** 当前待处理流程数量（用于诊断） */
  get size(): number {
    return this.flows.size;
  }
}

/**
 * 用默认 TTL 创建 PendingOAuthFlow。
 * 便捷函数，oauth:start handler 会用到。
 *
 * `Omit<PendingOAuthFlow, 'createdAt' | 'expiresAt'>` 是 TS 工具类型：
 * 表示“除了 createdAt/expiresAt 之外，其他字段都要传”。
 */
export function createPendingFlow(
  params: Omit<PendingOAuthFlow, 'createdAt' | 'expiresAt'>
): PendingOAuthFlow {
  const now = Date.now();
  return {
    ...params,
    createdAt: now,
    expiresAt: now + FLOW_TTL_MS,
  };
}
