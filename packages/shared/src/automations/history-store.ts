/**
 * History Store - 自动化历史文件写入与压缩的唯一入口
 *
 * 提供：
 * - appendAutomationHistoryEntry()：串行追加，达到全局上限时触发压缩
 * - compactAutomationHistory()：异步双层保留（运行时，带互斥锁）
 * - compactAutomationHistorySync()：同步双层保留（启动时，无需互斥锁）
 *
 * 同步与异步压缩共享同一个纯函数算法 compactEntries。
 * 所有历史写入都应走 appendAutomationHistoryEntry，互斥锁可防止并发写坏文件。
 */

import { appendFile, readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { createLogger } from '../utils/debug.ts';
import {
  AUTOMATIONS_HISTORY_FILE,
  AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  AUTOMATION_HISTORY_MAX_ENTRIES,
} from './constants.ts';

const log = createLogger('history-store');

// ============================================================================
// 每个 workspace 的互斥锁 - 串行化写入
// ============================================================================

const mutexes = new Map<string, Promise<void>>();

function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  mutexes.set(key, next.then(() => {}, () => {}));
  return next;
}

// ============================================================================
// 追加
// ============================================================================

/**
 * 记录自启动以来每个 workspace 的追加次数。
 * 启动压缩保证条目数 ≤ MAX_ENTRIES，因此该计数用于判断何时需要再次压缩。
 */
const appendCounters = new Map<string, number>();

/**
 * 向 JSONL 历史文件追加一条记录。
 * 当自启动以来的追加次数达到全局上限时触发压缩。
 *
 * 传入的 entry 必须是完整的历史对象（可用 webhook-utils.ts 里的
 * createWebhookHistoryEntry 或 createPromptHistoryEntry 构造）。
 */
export async function appendAutomationHistoryEntry(
  workspaceRootPath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE);

  await withMutex(workspaceRootPath, async () => {
    await appendFile(historyPath, JSON.stringify(entry) + '\n', 'utf-8');

    const count = (appendCounters.get(workspaceRootPath) ?? 0) + 1;
    appendCounters.set(workspaceRootPath, count);

    if (count >= AUTOMATION_HISTORY_MAX_ENTRIES) {
      appendCounters.set(workspaceRootPath, 0);
      await runCompaction(historyPath);
    }
  });
}

// ============================================================================
// 压缩
// ============================================================================

/**
 * 异步压缩历史文件（运行时路径，带互斥锁）。
 */
export async function compactAutomationHistory(
  workspaceRootPath: string,
  maxPerMatcher: number = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  maxTotal: number = AUTOMATION_HISTORY_MAX_ENTRIES,
): Promise<void> {
  const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE);

  await withMutex(workspaceRootPath, () => runCompaction(historyPath, maxPerMatcher, maxTotal));
}

/**
 * 同步压缩历史文件（启动路径）。
 * 启动阶段是单线程的，且发生在任何异步追加之前，因此不需要互斥锁。
 */
export function compactAutomationHistorySync(
  workspaceRootPath: string,
  maxPerMatcher: number = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  maxTotal: number = AUTOMATION_HISTORY_MAX_ENTRIES,
): void {
  const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE);
  if (!existsSync(historyPath)) return;

  let content: string;
  try { content = readFileSync(historyPath, 'utf-8'); } catch { return; }

  const result = compactEntries(content, maxPerMatcher, maxTotal);
  if (!result) return;

  writeFileSync(historyPath, result, 'utf-8');
  log.debug(`[HistoryStore] Startup compaction complete`);
}

/**
 * 内部异步压缩函数 - 必须在 withMutex 内部调用。
 */
async function runCompaction(
  historyPath: string,
  maxPerMatcher: number = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
  maxTotal: number = AUTOMATION_HISTORY_MAX_ENTRIES,
): Promise<void> {
  let content: string;
  try {
    if (!existsSync(historyPath)) return;
    content = await readFile(historyPath, 'utf-8');
  } catch {
    return;
  }

  const result = compactEntries(content, maxPerMatcher, maxTotal);
  if (!result) return;

  await writeFile(historyPath, result, 'utf-8');
  log.debug(`[HistoryStore] Compacted history`);
}

// ============================================================================
// 纯函数压缩算法 - 同步/异步路径共用
// ============================================================================

/**
 * 对 JSONL 内容应用双层保留策略：
 * 1. 每个 automation ID 最多保留最近 maxPerMatcher 条
 * 2. 如果仍超过全局上限 maxTotal，则丢弃最旧的记录
 *
 * 同时丢弃解析失败的 JSON 行。
 *
 * @returns 压缩后的字符串；如果无需压缩则返回 null
 */
function compactEntries(
  content: string,
  maxPerMatcher: number,
  maxTotal: number,
): string | null {
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  // 解析所有行，损坏的行直接丢弃
  const entries: Array<{ raw: string; id: string }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push({ raw: line, id: parsed.id ?? '' });
    } catch {
      // 丢弃损坏行
    }
  }

  // 记录原始行数（含损坏行），用于判断是否真的需要重写
  const originalLineCount = lines.length;

  // 1) 每个 ID 保留最近 N 条
  const byId = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i]!.id;
    let group = byId.get(id);
    if (!group) {
      group = [];
      byId.set(id, group);
    }
    group.push(i);
  }

  const keepIndices = new Set<number>();
  for (const indices of byId.values()) {
    const kept = indices.slice(-maxPerMatcher);
    for (const idx of kept) {
      keepIndices.add(idx);
    }
  }

  let trimmed = entries.filter((_, i) => keepIndices.has(i));

  // 2) 全局上限：仍超过则丢弃最旧的
  if (trimmed.length > maxTotal) {
    trimmed = trimmed.slice(-maxTotal);
  }

  if (trimmed.length === originalLineCount) return null;

  return trimmed.map(e => e.raw).join('\n') + '\n';
}
