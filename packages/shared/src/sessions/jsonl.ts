/**
 * JSONL 会话存储
 *
 * 提供读写 JSONL 格式 session 文件的工具函数。
 * 文件格式：第 1 行是 SessionHeader，第 2 行起每条 StoredMessage 占一行。
 */

import { openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { open, readFile } from 'fs/promises';
import { dirname } from 'path';
import type { SessionHeader, StoredSession, StoredMessage, SessionTokenUsage } from './types.ts';
import type { PermissionMode } from '../agent/mode-types.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';
import { toPortablePath, expandPath, normalizePath } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { safeJsonParse } from '../utils/files.ts';
import { pickSessionFields } from './utils.ts';

// ============================================================
// 会话路径可移植性
// ============================================================

const SESSION_PATH_TOKEN = '{{SESSION_PATH}}';

/**
 * 把绝对会话目录路径替换为可移植的占位符。
 *
 * 在 JSON.stringify 之后调用，这样消息内容里嵌入的路径
 *（datatable src、planPath、附件 storedPath 等）都能随文件迁移。
 */
export function makeSessionPathPortable(jsonLine: string, sessionDir: string): string {
  if (!sessionDir) return jsonLine;
  const normalized = normalizePath(sessionDir);
  let result = jsonLine.replaceAll(normalized, SESSION_PATH_TOKEN);
  // Windows 上 JSON.stringify 会把 \ 转义成 \\，所以也要替换这种形式
  if (sessionDir !== normalized) {
    const jsonEscaped = sessionDir.replaceAll('\\', '\\\\');
    result = result.replaceAll(jsonEscaped, SESSION_PATH_TOKEN);
  }
  return result;
}

/**
 * 把可移植占位符展开回绝对路径。
 * 在 JSON.parse 之前调用，运行时所有路径引用才能正确解析。
 */
export function expandSessionPath(jsonLine: string, sessionDir: string): string {
  if (!jsonLine.includes(SESSION_PATH_TOKEN)) return jsonLine;
  return jsonLine.replaceAll(SESSION_PATH_TOKEN, normalizePath(sessionDir));
}

function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  return parsePermissionMode(value) ?? undefined;
}

/**
 * 规范化 header 里的 permissionMode/previousPermissionMode。
 * 读取旧文件时可能存的是字符串，这里转成内部枚举类型。
 */
function normalizeHeaderPermissionModes<T extends SessionHeader>(header: T): T {
  const permissionMode = normalizePermissionMode(header.permissionMode);
  const previousPermissionMode = normalizePermissionMode(header.previousPermissionMode);

  if (permissionMode) {
    header.permissionMode = permissionMode;
  } else {
    delete (header as Partial<SessionHeader>).permissionMode;
  }

  if (previousPermissionMode) {
    header.previousPermissionMode = previousPermissionMode;
  } else {
    delete (header as Partial<SessionHeader>).previousPermissionMode;
  }

  return header;
}

/**
 * 只读取 session.jsonl 的第一行（header），用于快速列表加载。
 * 使用低层 fs 接口，只读最少字节，避免加载整条消息历史。
 */
export function readSessionHeader(sessionFile: string): SessionHeader | null {
  try {
    const fd = openSync(sessionFile, 'r');
    const buffer = Buffer.alloc(8192); // 8KB 对元数据 header 来说足够
    const bytesRead = readSync(fd, buffer, 0, 8192, 0);
    closeSync(fd);

    const content = buffer.toString('utf-8', 0, bytesRead);
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;

    const parsed = safeJsonParse(expandSessionPath(firstLine, dirname(sessionFile))) as SessionHeader;
    return normalizeHeaderPermissionModes(parsed);
  } catch (error) {
    debug('[jsonl] Failed to read session header:', sessionFile, error);
    return null;
  }
}

/**
 * 读取完整的 JSONL 会话文件。
 * 解析 header 和所有消息行。
 */
export function readSessionJsonl(sessionFile: string): StoredSession | null {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const firstLine = lines[0];
    if (!firstLine) return null;

    const sessionDir = dirname(sessionFile);
    const header = normalizeHeaderPermissionModes(
      safeJsonParse(expandSessionPath(firstLine, sessionDir)) as SessionHeader
    );
    // 容灾解析：某一行损坏（比如崩溃导致截断）时跳过该行，
    // 而不是让整个会话的消息全部丢失。
    // 先展开路径占位符，再解析，确保嵌入路径正确。
    const expandedMessageLines = lines.slice(1).map(line => expandSessionPath(line, sessionDir));
    const messages = parseMessagesResilient(expandedMessageLines);

    // 兼容旧数据：早期没有 sdkCwd 字段时，用 workingDirectory 兜底。
    // 因为旧代码就是用 workingDirectory 作为 SDK 的 cwd 参数。
    const workingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workingDir;

    return {
      ...pickSessionFields(header),
      // 把可移植路径展开为本地绝对路径
      workspaceRootPath: expandPath(header.workspaceRootPath),
      workingDirectory: workingDir,
      sdkCwd,
      // 运行时字段
      messages,
      tokenUsage: header.tokenUsage,
    } as StoredSession;
  } catch (error) {
    debug('[jsonl] Failed to read session:', sessionFile, error);
    return null;
  }
}

/**
 * 把会话写入 JSONL 文件，使用原子写（先写 .tmp 再 rename）。
 * 即使进程在写入中崩溃，也不会出现半写文件：要么保留旧文件，要么新文件完整。
 *
 * 第 1 行：带预计算元数据的 header
 * 第 2 行起：每条消息一行
 */
export function writeSessionJsonl(sessionFile: string, session: StoredSession): void {
  const header = createSessionHeader(session);
  const sessionDir = dirname(sessionFile);

  const lines = [
    makeSessionPathPortable(JSON.stringify(header), sessionDir),
    ...session.messages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
  ];

  const tmpFile = sessionFile + '.tmp';
  writeFileSync(tmpFile, lines.join('\n') + '\n');
  // Windows 上 rename 目标存在会失败，先删除以实现跨平台兼容
  try { unlinkSync(sessionFile); } catch { /* 文件不存在时忽略 */ }
  renameSync(tmpFile, sessionFile);
}

/**
 * 从 StoredSession 创建 SessionHeader。
 * 预计算 messageCount、preview、lastMessageRole 等字段，
 * 这样列表加载时不用解析全部消息。
 *
 * 使用 pickSessionFields() 保证所有持久化字段都被包含。
 */
export function createSessionHeader(session: StoredSession): SessionHeader {
  return {
    ...pickSessionFields(session),
    // 路径转换，便于跨机器迁移
    workspaceRootPath: toPortablePath(session.workspaceRootPath),
    // 更新 lastUsedAt 为保存时间，而不是原始时间
    lastUsedAt: Date.now(),
    // 预计算字段
    messageCount: session.messages.length,
    lastMessageRole: extractLastMessageRole(session.messages),
    preview: extractPreview(session.messages),
    tokenUsage: session.tokenUsage,
    lastFinalMessageId: extractLastFinalMessageId(session.messages),
  } as SessionHeader;
}

/**
 * 提取最后一条消息的 role，用于列表上的角标展示。
 * 只返回 UI 关心的几类：user、assistant、plan、tool、error。
 */
function extractLastMessageRole(messages: StoredMessage[]): SessionHeader['lastMessageRole'] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return undefined;
  // 把内部类型映射到展示用的子集
  const role = lastMessage.type;
  if (role === 'user' || role === 'assistant' || role === 'plan' || role === 'tool' || role === 'error') {
    return role;
  }
  return undefined;
}

/**
 * 提取最后一条非中间态 assistant 消息的 ID。
 * 列表未读检测用它，避免加载全部消息。
 */
function extractLastFinalMessageId(messages: StoredMessage[]): string | undefined {
  // 从后往前找第一个非 intermediate 的 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === 'assistant' && !msg.isIntermediate) {
      return msg.id;
    }
  }
  return undefined;
}

/**
 * 从第一条用户消息提取预览文本。
 * 会去掉特殊块、标签、方括号提及，并归一化空白。
 * 最多返回前 150 个字符。
 */
function extractPreview(messages: StoredMessage[]): string | undefined {
  const firstUserMessage = messages.find(m => m.type === 'user');
  if (!firstUserMessage?.content) return undefined;

  // 清理：去掉特殊块、标签、方括号提及，压缩空白
  const sanitized = firstUserMessage.content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // 去掉整个 edit_request 块
    .replace(/<[^>]+>/g, '')     // 去掉剩余 XML/HTML 标签
    .replace(/\[skill:(?:[\w-]+:)?[\w-]+\]/g, '')   // 去掉 [skill:...] 提及
    .replace(/\[source:[\w-]+\]/g, '')              // 去掉 [source:...] 提及
    .replace(/\[file:[^\]]+\]/g, '')                // 去掉 [file:...] 提及
    .replace(/\[folder:[^\]]+\]/g, '')              // 去掉 [folder:...] 提及
    .replace(/\s+/g, ' ')        // 合并空白（包括换行）
    .trim();

  return sanitized.substring(0, 150) || undefined;
}

/**
 * readSessionHeader 的异步版本，支持并行 I/O。
 * 使用 fs/promises 避免阻塞事件循环。
 */
export async function readSessionHeaderAsync(sessionFile: string): Promise<SessionHeader | null> {
  try {
    const handle = await open(sessionFile, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
      const content = buffer.toString('utf-8', 0, bytesRead);
      const firstNewline = content.indexOf('\n');
      const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;
      const parsed = safeJsonParse(expandSessionPath(firstLine, dirname(sessionFile))) as SessionHeader;
      return normalizeHeaderPermissionModes(parsed);
    } finally {
      await handle.close();
    }
  } catch (error) {
    debug('[jsonl] Failed to read session header async:', sessionFile, error);
    return null;
  }
}

/**
 * 只读取 JSONL 文件中的消息（跳过 header）。
 * 用于选中会话后的懒加载。
 * 对损坏/截断行有容错：跳过而不是整体失败。
 */
export function readSessionMessages(sessionFile: string): StoredMessage[] {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    // 跳过第一行 header，展开路径占位符，再容灾解析剩余行
    const sessionDir = dirname(sessionFile);
    const expandedLines = lines.slice(1).map(line => expandSessionPath(line, sessionDir));
    return parseMessagesResilient(expandedLines);
  } catch (error) {
    debug('[jsonl] Failed to read session messages:', sessionFile, error);
    return [];
  }
}

/**
 * 容灾解析消息行：JSON.parse 失败时跳过该行。
 * 例如崩溃导致写入截断时，丢一条消息总比丢全部消息好。
 */
function parseMessagesResilient(lines: string[]): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as StoredMessage);
    } catch {
      // 损坏或截断行（很可能是崩溃时产生的），跳过
      debug('[jsonl] Skipping corrupted message line (truncated?):', line.substring(0, 100));
    }
  }
  return messages;
}
