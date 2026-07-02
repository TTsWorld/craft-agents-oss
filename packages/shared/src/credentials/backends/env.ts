/**
 * 环境变量后端（当前已禁用）
 *
 * 该后端当前被禁用，以强制用户手动输入 API key。
 * 保留文件作为未来可能启用的占位。
 */

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';

/**
 * 环境变量后端实现。
 * 实现了 CredentialBackend 接口，类似 Golang 中实现了 interface 的 struct。
 */
export class EnvironmentBackend implements CredentialBackend {
  readonly name = 'environment';
  readonly priority = 110; // 优先级高于文件后端（100），这样环境变量可以覆盖文件存储

  async isAvailable(): Promise<boolean> {
    // 按需求禁用，强制用户手动输入 API key
    return false;
  }

  async get(_id: CredentialId): Promise<StoredCredential | null> {
    return null;
  }

  async set(_id: CredentialId, _credential: StoredCredential): Promise<void> {
    throw new Error('Environment backend is disabled');
  }

  async delete(_id: CredentialId): Promise<boolean> {
    return false;
  }

  async list(_filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    return [];
  }
}
