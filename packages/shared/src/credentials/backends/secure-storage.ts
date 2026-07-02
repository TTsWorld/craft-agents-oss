/**
 * 安全存储后端（Secure Storage Backend）
 *
 * 把凭证存储在加密文件 ~/.craft-agent/credentials.enc 中，
 * 使用 AES-256-GCM 进行认证加密。
 *
 * 加密密钥由操作系统原生硬件 UUID 经 PBKDF2 派生：
 * - macOS: IOPlatformUUID（绑定主板，不会变）
 * - Windows: 注册表中的 MachineGuid（系统安装时生成）
 * - Linux: /var/lib/dbus/machine-id（系统安装时生成）
 *
 * 这比旧版基于 hostname 的派生更稳定，因为 hostname 可能随网络/DHCP 变化。
 * 旧版凭证会在首次加载时自动迁移。
 *
 * 文件格式：
 *   [文件头 - 64 字节]
 *   ├── Magic: "CRAFT01\0"（8 字节）
 *   ├── Flags: uint32 LE（4 字节）——预留
 *   ├── Salt: 32 字节（PBKDF2 盐）
 *   ├── Reserved: 20 字节
 *   [加密负载]
 *   ├── IV: 12 字节（每次写入随机生成）
 *   ├── Auth Tag: 16 字节（GCM 认证标签）
 *   └── Ciphertext: 变长（加密后的 JSON）
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { hostname, userInfo, homedir } from 'os';
import { join, dirname } from 'path';

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';

// 文件路径
const CREDENTIALS_DIR = join(homedir(), '.craft-agent');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.enc');

// 文件格式常量
const MAGIC_BYTES = Buffer.from('CRAFT01\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 迭代次数，在安全性和启动速度之间取平衡
const PBKDF2_ITERATIONS = 100000;

/**
 * 获取稳定的机器标识，使用操作系统原生硬件 UUID。
 * 这比 hostname 稳定得多，因为 hostname 可能随网络/DHCP 变化。
 * 如果硬件 UUID 拿不到，就回退到 username + homedir。
 */
function getStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID ——绑定主板，不会变
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: 注册表 MachineGuid ——系统安装时生成
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id ——系统安装时生成
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // 出错则走后面的兜底逻辑
  }

  // 兜底：username + homedir（大多数场景下足够稳定）
  return `${userInfo().username}:${homedir()}`;
}

/** 内部凭证仓库结构 */
interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

/**
 * 安全存储后端实现。
 * 实现 CredentialBackend 接口，类似 Golang 里实现了某个 interface 的 struct。
 */
export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;

  async isAvailable(): Promise<boolean> {
    // 文件后端永远可用——我们总能写入文件系统
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] || null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    let store = await this.loadStore();

    if (!store) {
      // 初始化新仓库
      store = {
        version: 1,
        credentials: {},
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }

    const key = credentialIdToAccount(id);
    store.credentials[key] = credential;
    store.metadata.updatedAt = Date.now();

    await this.saveStore(store);
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const store = this.loadStoreSync();
    if (!store) return false;

    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;

    delete store.credentials[key];
    store.metadata.updatedAt = Date.now();

    this.saveStoreSync(store);
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  // ============================================================
  // 私有方法
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    // 有缓存直接返回
    if (this.cachedStore) return this.cachedStore;

    if (!existsSync(CREDENTIALS_FILE)) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(CREDENTIALS_FILE);
    } catch {
      return null;
    }

    // 校验最小长度
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      // 文件已损坏，删除并返回 null
      this.handleCorruptedFile();
      return null;
    }

    // 校验 magic 字节
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.handleCorruptedFile();
      return null;
    }

    // 解析文件头
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // 预留，暂未使用
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // 提取加密数据
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // 先尝试新稳定密钥（v2，基于硬件 UUID）
    const newKey = this.getEncryptionKey(salt);
    let store = this.tryDecrypt(encryptedData, newKey);

    if (store) {
      this.cachedStore = store;
      return store;
    }

    // 再尝试旧密钥，用于迁移（v1，包含 hostname）
    // 这能解密用旧版密钥派生方式加密的凭证
    const legacyKey = this.getLegacyEncryptionKey(salt);
    store = this.tryDecrypt(encryptedData, legacyKey);

    if (store) {
      // 迁移：用新稳定密钥重新保存，以后加载就用硬件 UUID 密钥
      this.cachedStore = store;
      this.saveStoreSync(store);
      return store;
    }

    // 两种密钥都失败——文件确实已损坏
    this.handleCorruptedFile();
    return null;
  }

  /**
   * 尝试用给定密钥解密数据。
   * 成功返回解析后的仓库，失败返回 null。
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  private async saveStore(store: CredentialStore): Promise<void> {
    this.saveStoreSync(store);
  }

  private saveStoreSync(store: CredentialStore): void {
    // 确保目录存在
    if (!existsSync(CREDENTIALS_DIR)) {
      mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    }

    // 复用已有 salt，没有则生成新的
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // 获取加密密钥
    const key = this.getEncryptionKey(salt);

    // 序列化明文
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // 每次写入都生成新 IV（GCM 安全性的关键）
    const iv = randomBytes(IV_SIZE);

    // 加密
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 组装文件头
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags（预留）
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // 组合所有部分
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // 以严格权限写入（仅所有者可读写）
    writeFileSync(CREDENTIALS_FILE, fileData, { mode: 0o600 });
    this.cachedStore = store;
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // 新版稳定机器 ID，使用硬件 UUID（v2）
    // 比 hostname 稳定得多，hostname 可能随网络/DHCP 变化
    const stableMachineId = createHash('sha256')
      .update(getStableMachineId())
      .update('craft-agent-v2') // 密钥派生版本号升级
      .digest();

    // 用 PBKDF2 派生密钥
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');

    return this.encryptionKey;
  }

  /**
   * 旧版密钥派生，用于从 v1 迁移（v1 包含 hostname）。
   * 先用旧密钥解密，再重新用稳定密钥加密。
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('craft-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  private handleCorruptedFile(): void {
    // 删除损坏文件——用户需要重新输入凭证
    try {
      if (existsSync(CREDENTIALS_FILE)) {
        unlinkSync(CREDENTIALS_FILE);
      }
    } catch {
      // 忽略删除错误
    }
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
  }

  /** 清空缓存（测试或强制刷新时用） */
  clearCache(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
  }
}
