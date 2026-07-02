/**
 * 凭证后端接口
 *
 * 所有凭证存储后端都必须实现这个 interface。
 * 后端按 priority 从高到低依次尝试，直到有一个成功。
 *
 * 可以类比 Golang：这相当于一个 interface，规定了 credential backend
 * 必须提供的方法；各个后端就是实现该 interface 的具体类型。
 */

import type { CredentialId, StoredCredential } from '../types.ts';

export interface CredentialBackend {
  /** 后端名称，用于日志/调试 */
  readonly name: string;

  /** 优先级，数字越大越先被尝试 */
  readonly priority: number;

  /** 检查当前后端在当前平台是否可用 */
  isAvailable(): Promise<boolean>;

  /** 根据 ID 获取凭证 */
  get(id: CredentialId): Promise<StoredCredential | null>;

  /** 设置/更新凭证 */
  set(id: CredentialId, credential: StoredCredential): Promise<void>;

  /** 删除凭证 */
  delete(id: CredentialId): Promise<boolean>;

  /** 同步删除凭证（后端支持时） */
  deleteSync?(id: CredentialId): boolean;

  /** 列出所有凭证（可传入部分 CredentialId 作为过滤条件） */
  list(filter?: Partial<CredentialId>): Promise<CredentialId[]>;
}
