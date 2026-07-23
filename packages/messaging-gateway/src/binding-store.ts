/**
 * BindingStore —— workspace 作用域的 channel binding 持久化。
 *
 * 在一个显式存储目录（由调用方传入）里保存 bindings。Electron 下是
 * `~/.craft-agent/workspaces/{wsId}/messaging/`，测试可以指向任意目录。
 *
 * 一次性迁移：如果传入了 legacy 目录且其中存在 bindings.json、而新路径下没有，
 * 则在构造时把 legacy 文件拷贝到新位置。
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChannelBinding, MessagingLogger, PlatformType } from './types'
import { normalizeBindingConfig } from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

export class BindingStore {
  private bindings: ChannelBinding[] = []
  private readonly filePath: string
  private readonly dirPath: string
  private readonly log: MessagingLogger
  private changeListener?: () => void

  /**
   * @param storageDir  bindings.json 存放目录的绝对路径。
   * @param legacyDir   可选的 legacy 目录。如果其下存在 bindings.json、而新位置没有，
   *                    则把该文件拷贝到新位置一次。
   */
  constructor(storageDir: string, legacyDir?: string, logger: MessagingLogger = NOOP_LOGGER) {
    this.dirPath = storageDir
    this.filePath = join(storageDir, 'bindings.json')
    this.log = logger
    this.migrateLegacy(legacyDir)
    this.load()
  }

  /** 注册一个回调，在任意变更被持久化后触发。 */
  onChange(fn: () => void): void {
    this.changeListener = fn
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /**
   * 查找 (platform, channelId, threadId) 元组对应的活跃 binding。
   * `threadId` 用于区分 Telegram 超级群的各个论坛话题，以及与超级群的
   * General 话题 / DM（undefined）区分开。
   *
   * 不带 `threadId` 创建的 binding（DM、topics 功能上线前的旧数据）
   * 只会匹配 `threadId === undefined` 的查询。
   */
  findByChannel(platform: PlatformType, channelId: string, threadId?: number): ChannelBinding | undefined {
    return this.bindings.find(
      (b) =>
        b.platform === platform &&
        b.channelId === channelId &&
        (b.threadId ?? undefined) === threadId &&
        b.enabled,
    )
  }

  findBySession(sessionId: string): ChannelBinding[] {
    return this.bindings.filter((b) => b.sessionId === sessionId && b.enabled)
  }

  getAll(): ChannelBinding[] {
    return [...this.bindings]
  }

  // -------------------------------------------------------------------------
  // 变更
  // -------------------------------------------------------------------------

  bind(
    workspaceId: string,
    sessionId: string,
    platform: PlatformType,
    channelId: string,
    channelName?: string,
    config?: Partial<ChannelBinding['config']>,
    threadId?: number,
  ): ChannelBinding {
    // 一个 channel → 一个 session：踢掉 (platform, channelId, threadId)
    // 元组上已存在的任何 binding。同一超级群内的不同话题可以独立绑定。
    this.bindings = this.bindings.filter(
      (b) => !(b.platform === platform && b.channelId === channelId && (b.threadId ?? undefined) === threadId),
    )

    const binding: ChannelBinding = {
      id: randomUUID(),
      workspaceId,
      sessionId,
      platform,
      channelId,
      ...(threadId !== undefined ? { threadId } : {}),
      channelName,
      enabled: true,
      createdAt: Date.now(),
      config: normalizeBindingConfig(platform, config),
    }

    this.bindings.push(binding)
    this.save()
    this.log.info('binding created', {
      event: 'binding_created',
      workspaceId,
      sessionId,
      platform,
      channelId,
      threadId,
      bindingId: binding.id,
      channelName,
    })
    return binding
  }

  /**
   * 原地更新某个 binding 的 `BindingConfig` —— 保留 `id`、
   * `createdAt`、`channelId` 等。返回更新后的 binding
   *（找不到 id 则返回 null）。
   *
   * 当你只需要改 `accessMode` 或 `allowedSenderIds` 这类 config 字段时，
   * 用这个而不是 `bind()`。`bind()` 会踢掉并以一个新 UUID 重建，
   * 这会悄悄轮换 binding id，进而破坏所有以它为键的东西
   *（审计日志、深链、陈旧的 UI 闭包）。
   */
  updateBindingConfig(bindingId: string, patch: Partial<ChannelBinding['config']>): ChannelBinding | null {
    const binding = this.bindings.find((b) => b.id === bindingId)
    if (!binding) return null
    binding.config = normalizeBindingConfig(binding.platform, {
      ...binding.config,
      ...patch,
    })
    this.save()
    this.log.info('binding config updated', {
      event: 'binding_config_updated',
      bindingId,
      platform: binding.platform,
      patchedKeys: Object.keys(patch),
    })
    return binding
  }

  unbind(platform: PlatformType, channelId: string, threadId?: number): boolean {
    const before = this.bindings.length
    this.bindings = this.bindings.filter(
      (b) => !(b.platform === platform && b.channelId === channelId && (b.threadId ?? undefined) === threadId),
    )
    if (this.bindings.length !== before) {
      this.save()
      this.log.info('binding removed by channel', {
        event: 'binding_removed',
        platform,
        channelId,
        threadId,
      })
      return true
    }
    return false
  }

  unbindById(bindingId: string): boolean {
    const binding = this.bindings.find((b) => b.id === bindingId)
    if (!binding) return false
    this.bindings = this.bindings.filter((b) => b.id !== bindingId)
    this.save()
    this.log.info('binding removed by id', {
      event: 'binding_removed',
      bindingId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      platform: binding.platform,
      channelId: binding.channelId,
    })
    return true
  }

  unbindSession(sessionId: string, platform?: PlatformType): number {
    const removedBindings = this.bindings.filter((b) => {
      if (b.sessionId !== sessionId) return false
      if (platform && b.platform !== platform) return false
      return true
    })
    if (removedBindings.length === 0) return 0

    this.bindings = this.bindings.filter((b) => !removedBindings.includes(b))
    this.save()
    this.log.info('bindings removed by session', {
      event: 'binding_removed',
      sessionId,
      platform,
      removedCount: removedBindings.length,
      bindingIds: removedBindings.map((b) => b.id),
    })
    return removedBindings.length
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  private migrateLegacy(legacyDir?: string): void {
    if (!legacyDir) return
    const legacyFile = join(legacyDir, 'bindings.json')
    if (existsSync(this.filePath)) return
    if (!existsSync(legacyFile)) return
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      copyFileSync(legacyFile, this.filePath)
      this.log.info('bindings migrated from legacy location', {
        event: 'bindings_migrated',
        legacyFile,
        filePath: this.filePath,
      })
    } catch (err) {
      this.log.error('binding migration failed', {
        event: 'bindings_migration_failed',
        legacyFile,
        filePath: this.filePath,
        error: err,
      })
    }
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.bindings = parsed.map(normalizeBinding)
        }
      }
    } catch (err) {
      this.log.error('failed to load bindings store; resetting to empty', {
        event: 'bindings_load_failed',
        filePath: this.filePath,
        error: err,
      })
      this.bindings = []
    }
  }

  private save(): void {
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify(this.bindings, null, 2), 'utf-8')
      // 只在写盘成功后才触发 listener —— 否则 UI 会为一个重启后就会消失的状态
      // 弹出「binding 已添加」事件。
      this.changeListener?.()
    } catch (err) {
      this.log.error('failed to save bindings store', {
        event: 'bindings_save_failed',
        filePath: this.filePath,
        error: err,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 迁移辅助函数
// ---------------------------------------------------------------------------

function normalizeBinding(raw: ChannelBinding): ChannelBinding {
  return {
    ...raw,
    config: normalizeBindingConfig(raw.platform, raw.config ?? {}),
  }
}
