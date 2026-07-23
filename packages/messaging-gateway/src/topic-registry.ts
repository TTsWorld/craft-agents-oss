/**
 * TopicRegistry —— workspace 作用域的 automation 论坛话题缓存。
 *
 * 每个条目把一个用户指定的话题名映射到一个 Telegram 论坛话题 thread ID。
 * 第一次为某个 workspace 请求某个名字时，registry 会调用传入的
 * `createTopic` 回调并持久化返回的 threadId。之后对同一名字的请求返回
 * 缓存条目 —— 所以共享同一个 `telegramTopic` 值的多个 automation 共享一个话题。
 *
 * 存储：`{messagingDir}/topic-registry.json`
 *
 * 并发：每个 `(workspaceId, topicName)` 一个内存 async mutex，
 * 把同时到达的 create-or-reuse 请求串行化，这样两个争抢同一名字的
 * automation 运行只会创建一次话题。
 *
 * `createTopic` 抛出的错误会向上冒泡给调用方（让调用方能呈现
 *「没有 Manage Topics 权限」等，而无需 registry 替它做策略决策）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MessagingLogger } from './types'

export interface AutomationTopicEntry {
  /** 用户指定的话题名（大小写敏感）。与 workspaceId 一起作为缓存键。 */
  topicName: string
  platform: 'telegram'
  /** 承载该话题的超级群 Telegram chat ID。 */
  chatId: string
  /** `createForumTopic` 返回的 Telegram `message_thread_id`。 */
  threadId: number
  createdAt: number
  lastUsedAt: number
}

interface RegistryFileShape {
  version: 1
  entries: AutomationTopicEntry[]
}

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

const FILE_NAME = 'topic-registry.json'

export class TopicRegistry {
  private readonly filePath: string
  private readonly dirPath: string
  private readonly log: MessagingLogger
  /** 缓存：以 `topicName` 为键。每个 registry 实例对应一个 workspace。 */
  private byName = new Map<string, AutomationTopicEntry>()
  /** 每个话题名进行中的 find-or-create promise，用作 mutex。 */
  private inflight = new Map<string, Promise<AutomationTopicEntry>>()

  constructor(storageDir: string, logger: MessagingLogger = NOOP_LOGGER) {
    this.dirPath = storageDir
    this.filePath = join(storageDir, FILE_NAME)
    this.log = logger
    this.load()
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  get(topicName: string): AutomationTopicEntry | undefined {
    return this.byName.get(topicName)
  }

  list(): AutomationTopicEntry[] {
    return Array.from(this.byName.values())
  }

  // -------------------------------------------------------------------------
  // 变更
  // -------------------------------------------------------------------------

  /**
   * 返回 `topicName` 的缓存条目；若不存在，则调用 `createTopic(topicName)`
   * 在 `chatId` 里创建一个论坛话题，持久化结果并返回新条目。
   *
   * 同名的并发调用共享同一个 in-flight promise —— 只会发起一次 `createTopic` 调用。
   */
  async findOrCreate(args: {
    topicName: string
    chatId: string
    createTopic: (name: string) => Promise<{ threadId: number; name: string }>
  }): Promise<AutomationTopicEntry> {
    const { topicName, chatId, createTopic } = args

    const existing = this.byName.get(topicName)
    if (existing) {
      // 更新 lastUsedAt —— 尽力而为，不阻塞持久化
      existing.lastUsedAt = Date.now()
      this.save()
      return existing
    }

    const inflight = this.inflight.get(topicName)
    if (inflight) return inflight

    const promise = (async (): Promise<AutomationTopicEntry> => {
      // 在 mutex 内再查一次，防止另一个调用方在上面的 get()
      // 与下面的 inflight set 之间抢先一步。
      const racedExisting = this.byName.get(topicName)
      if (racedExisting) {
        racedExisting.lastUsedAt = Date.now()
        this.save()
        return racedExisting
      }

      const created = await createTopic(topicName)
      const now = Date.now()
      const entry: AutomationTopicEntry = {
        topicName,
        platform: 'telegram',
        chatId,
        threadId: created.threadId,
        createdAt: now,
        lastUsedAt: now,
      }
      this.byName.set(topicName, entry)
      this.save()
      this.log.info('topic created', {
        event: 'topic_created',
        topicName,
        chatId,
        threadId: entry.threadId,
      })
      return entry
    })()

    this.inflight.set(topicName, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(topicName)
    }
  }

  async remove(topicName: string): Promise<void> {
    if (!this.byName.delete(topicName)) return
    this.save()
    this.log.info('topic entry removed', {
      event: 'topic_removed',
      topicName,
    })
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as RegistryFileShape
      if (!parsed?.entries || !Array.isArray(parsed.entries)) return
      for (const entry of parsed.entries) {
        if (typeof entry?.topicName !== 'string') continue
        if (typeof entry.threadId !== 'number') continue
        if (typeof entry.chatId !== 'string') continue
        this.byName.set(entry.topicName, {
          topicName: entry.topicName,
          platform: 'telegram',
          chatId: entry.chatId,
          threadId: entry.threadId,
          createdAt: entry.createdAt ?? Date.now(),
          lastUsedAt: entry.lastUsedAt ?? entry.createdAt ?? Date.now(),
        })
      }
    } catch (err) {
      this.log.error('failed to load topic registry; ignoring file', {
        event: 'topic_registry_load_failed',
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dirPath, { recursive: true })
      const payload: RegistryFileShape = {
        version: 1,
        entries: Array.from(this.byName.values()),
      }
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8')
    } catch (err) {
      this.log.error('failed to save topic registry', {
        event: 'topic_registry_save_failed',
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
