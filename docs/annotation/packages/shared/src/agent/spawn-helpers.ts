/**
 * Claude SDK 子进程 spawn（拉起子进程）相关的辅助函数集合。
 *
 * 这一层单独抽出来，主要是为了让"目录探测"、"ENOENT 判定"、
 * "SDK 包装错误字符串的正则"这些逻辑可以独立做单测，
 * 而不必为了测试它们真的去拉起一个完整的 ClaudeAgent。
 *
 * 类比 Go：相当于把 spawn 相关的工具函数从主结构里拆到 utils.go，
 * 方便单独写表驱动测试。
 */

import { lstatSync } from 'node:fs';

/**
 * 判断给定路径 `p` 是否是一个已存在的目录。
 *
 * 这里特意用 `lstatSync`（而不是 `statSync`）：
 * - 当 `p` 是一个指向不存在目标的符号链接（broken symlink）时，
 *   `lstatSync` 本身能拿到符号链接自身的 stat，但随后 `.isDirectory()`
 *   会返回 false——这是我们想要的行为，因为对 broken symlink 调用
 *   spawn() 一样会失败，必须把它当作"不存在"处理。
 * - 整体包在 try/catch 里，是为了把 EACCES（无权限）/ ENOTDIR（不是目录）
 *   之类的异常统一收敛成 false，调用方只需关心 boolean。
 *
 * @param p 待检查的路径，允许 null/undefined（直接返回 false）
 */
export function isExistingDirectory(p: string | null | undefined): boolean {
  if (!p) return false;
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 匹配 SDK 抛出的 `ReferenceError("Claude Code native binary not found at <path>")`
 * （以及旧版本里的 `executable not found at <path>` 变体），并捕获其中的 <path>。
 *
 * 设计要点：
 * - 用贪婪捕获到行尾，是为了完整保留 macOS 安装包路径，例如
 *   `/Applications/Craft Agents.app/...`（中间也可能带空格）。
 * - 末尾若恰好有一个句号（SDK 历史版本会附加一个英文句号结尾），
 *   只剥掉这一个句号，路径本身里的点不动。
 *
 * 正则中的 `(?:native binary|executable)` 用非捕获组兼容两种措辞。
 */
const SDK_BINARY_NOT_FOUND_RE = /Claude Code (?:native binary|executable) not found at\s+(.+)$/m;

/**
 * 从 SDK 抛出的错误字符串里提取它报告的"二进制路径"。
 *
 * @param rawErrorMsg SDK/进程抛出的原始错误信息
 * @returns 命中时返回捕获到的路径；未命中或入参为空时返回 undefined
 */
export function extractSdkReportedBinaryPath(rawErrorMsg: string | null | undefined): string | undefined {
  if (!rawErrorMsg) return undefined;
  const match = SDK_BINARY_NOT_FOUND_RE.exec(rawErrorMsg);
  if (!match || !match[1]) return undefined;
  // 仅剥掉结尾可能存在的一个句号（SDK 历史版本会附加），其余字符原样保留。
  return match[1].replace(/\.\s*$/, '');
}

/**
 * 判断一次 spawn 是否因为 ENOENT（找不到可执行文件）而失败。
 *
 * Node 与 SDK 可能把同一类错误通过多种渠道抛出来，这里把所有已知渠道都覆盖：
 * - 抛出错误对象上的结构化字段：`code === 'ENOENT'` 且 `syscall` 以 `spawn` 开头；
 * - 错误信息（或 stderr）里出现了 `spawn … ENOENT` 这样的字符串；
 * - SDK 自己的包装字符串：`Claude Code native binary not found at …`。
 *
 * 只要命中任意一条就认为是 ENOENT，方便上层给出统一的"二进制缺失"提示。
 *
 * @param input 错误对象上的结构化字段 + 原始错误信息 + stderr 文本
 */
export function isSpawnEnoent(input: {
  errorCode?: string;
  errorSyscall?: string;
  rawErrorMsg?: string | null;
  stderr?: string | null;
}): boolean {
  const { errorCode, errorSyscall, rawErrorMsg, stderr } = input;
  // 渠道一：结构化字段。Node 在 spawn 失败时会填 error.code/error.syscall。
  if (errorCode === 'ENOENT' && errorSyscall && errorSyscall.startsWith('spawn')) return true;
  // 渠道二：原始错误信息里的 "spawn ... ENOENT" 文本（中间允许跨行）。
  if (rawErrorMsg && /\bspawn\b[\s\S]*\bENOENT\b/.test(rawErrorMsg)) return true;
  // 渠道三：stderr 里的 "spawn ... ENOENT" 文本（子进程可能把它打到 stderr）。
  if (stderr && /\bspawn\b[\s\S]*\bENOENT\b/.test(stderr)) return true;
  // 渠道四：SDK 自己包装的"二进制未找到"字符串。
  if (rawErrorMsg && SDK_BINARY_NOT_FOUND_RE.test(rawErrorMsg)) return true;
  return false;
}
