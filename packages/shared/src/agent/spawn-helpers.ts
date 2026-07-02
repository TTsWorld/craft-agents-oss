/**
 * Claude SDK 子进程 spawn（拉起子进程）位置用到的辅助函数集合。
 *
 * 单独拆成一个模块，是为了让「目录探测」「ENOENT（文件不存在）检测」
 * 以及 SDK 包装字符串的正则匹配，都可以在不启动完整 ClaudeAgent
 * 的情况下做单元测试。
 */

import { lstatSync } from 'node:fs';

/**
 * 判断给定路径 `p` 是否为一个真实存在的目录，是则返回 true。
 *
 * 这里用 `lstatSync`（而不是 `statSync`）：当 `p` 是一个指向已失效目标的
 * 符号链接（broken symlink）时，它会返回 false——这类坏链必须被视作「不存在」，
 * 因为 Node 的 spawn() 反正也会在它们上面失败。整体包在 try/catch 里，
 * 让 EACCES（无权限）/ ENOTDIR（不是目录）等异常都能干净地降级为 false。
 *
 * 类比 Golang：相当于 Lstat + os.IsNotExist 的合体，但把所有错误都吞掉。
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
 * 用于匹配 SDK 抛出的 `ReferenceError("Claude Code native binary not found at <path>")`
 * （以及旧版本里的 `executable not found at <path>` 变体），并捕获其中的路径。
 *
 * 说明：
 * - 使用贪婪匹配一直抓到行尾，是为了完整保留 macOS 的 bundle 路径，例如
 *   `/Applications/Craft Agents.app/...` 这种带空格的多段路径。
 * - 历史上 SDK 在句末会多加一个英文句号，因此当且仅当末尾存在单个 `.` 时
 *   才把它去掉，避免误伤路径本身。
 */
const SDK_BINARY_NOT_FOUND_RE = /Claude Code (?:native binary|executable) not found at\s+(.+)$/m;

/**
 * 从一段错误信息文本里提取 SDK 自报的「原生二进制文件路径」。
 * 找不到匹配就返回 undefined。
 */
export function extractSdkReportedBinaryPath(rawErrorMsg: string | null | undefined): string | undefined {
  if (!rawErrorMsg) return undefined;
  const match = SDK_BINARY_NOT_FOUND_RE.exec(rawErrorMsg);
  if (!match || !match[1]) return undefined;
  return match[1].replace(/\.\s*$/, '');
}

/**
 * 判断一次「子进程拉起」是否因为 ENOENT（找不到可执行文件）而失败。
 *
 * Node 和 SDK 会从多个不同通道暴露这种失败，这里把它们全部覆盖：
 * - 抛出错误对象上的结构化字段（`code === 'ENOENT'` 且 `syscall` 以 `spawn` 开头）；
 * - 错误信息文本或捕获到的 stderr 里出现形如 `spawn … ENOENT` 的字符串；
 * - SDK 自己包装过的字符串（`Claude Code native binary not found at …`）。
 *
 * 只要命中任意一种，就认定是 spawn ENOENT。
 */
export function isSpawnEnoent(input: {
  errorCode?: string;
  errorSyscall?: string;
  rawErrorMsg?: string | null;
  stderr?: string | null;
}): boolean {
  const { errorCode, errorSyscall, rawErrorMsg, stderr } = input;
  if (errorCode === 'ENOENT' && errorSyscall && errorSyscall.startsWith('spawn')) return true;
  if (rawErrorMsg && /\bspawn\b[\s\S]*\bENOENT\b/.test(rawErrorMsg)) return true;
  if (stderr && /\bspawn\b[\s\S]*\bENOENT\b/.test(stderr)) return true;
  if (rawErrorMsg && SDK_BINARY_NOT_FOUND_RE.test(rawErrorMsg)) return true;
  return false;
}
