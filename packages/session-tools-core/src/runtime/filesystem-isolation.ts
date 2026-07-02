/**
 * 文件系统隔离（filesystem isolation）
 *
 * 本模块负责为脚本沙箱（script sandbox）构造一层“笼子”：
 * 子进程只能写入当前 session 目录，无法越界修改宿主系统的其他路径。
 * 类比 Golang：相当于在启动 os/exec.Cmd 之前，先给它套一个 chroot/namespace 规则。
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * 文件系统隔离方案
 * status: 是否成功启用
 * backend: 使用哪种后端实现
 * command/args: 最终要执行的命令及其参数
 */
export interface FilesystemIsolationPlan {
  status: 'enforced' | 'unavailable';
  backend: 'sandbox-exec' | 'bwrap' | 'firejail' | 'none';
  command: string;
  args: string[];
}

/**
 * 文件系统隔离的可选配置
 * includeNetworkDeny: 是否同时禁止网络（用于和 network isolation 配合）
 */
export interface FilesystemIsolationOptions {
  includeNetworkDeny?: boolean;
}

/**
 * 检查某个可执行文件是否在 PATH 中
 * Windows 用 where，其他系统用 which
 */
function existsOnPath(binary: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [binary], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * sandbox-exec 可用性缓存，避免重复探测
 * boolean | null 是 TS 联合类型，null 表示“尚未探测”
 */
let sandboxExecUsableCache: boolean | null = null;

/**
 * 探测当前系统是否可用 sandbox-exec
 * 通过执行一个最小 profile 并看退出码判断
 */
function canUseSandboxExec(): boolean {
  if (sandboxExecUsableCache !== null) return sandboxExecUsableCache;
  if (!existsOnPath('sandbox-exec')) {
    sandboxExecUsableCache = false;
    return false;
  }

  const probe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { stdio: 'ignore' });
  sandboxExecUsableCache = probe.status === 0;
  return sandboxExecUsableCache;
}

/**
 * 对路径里的反斜杠和双引号做转义，防止拼接到 sandbox profile 时语法出错
 */
function escapeSandboxPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 为 macOS sandbox-exec 构造 profile 字符串
 * 规则：默认拒绝所有文件写入，但允许写入 sessionDir 及其子目录
 */
export function buildDarwinSandboxProfile(
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): string {
  const escapedRoot = escapeSandboxPath(resolve(sessionDir));
  const profileParts = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${escapedRoot}"))`,
  ];

  // 如果调用方希望同时禁网，就在 profile 里追加网络拒绝规则
  if (options?.includeNetworkDeny) {
    profileParts.push('(deny network*)');
  }

  return profileParts.join(' ');
}

/**
 * 把原始命令包装成“带文件系统隔离”的命令。
 *
 * 当前支持的平台：
 * - macOS: sandbox-exec profile
 * - Linux: bubblewrap（优先）或 firejail private/whitelist profile
 * - 其他平台: 不可用（对 script_sandbox 采取 fail-safe）
 */
export function applyFilesystemIsolation(
  command: string,
  args: string[],
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): FilesystemIsolationPlan {
  const sessionRoot = resolve(sessionDir);

  if (process.platform === 'darwin' && canUseSandboxExec()) {
    const profile = buildDarwinSandboxProfile(sessionRoot, options);

    return {
      status: 'enforced',
      backend: 'sandbox-exec',
      command: 'sandbox-exec',
      args: ['-p', profile, command, ...args],
    };
  }

  if (process.platform === 'linux') {
    if (existsOnPath('bwrap')) {
      // Linux bubblewrap：根目录只读绑定，session 目录可写绑定。
      // 这样运行时可以访问系统库，但写入被限制在 sessionRoot。
      return {
        status: 'enforced',
        backend: 'bwrap',
        command: 'bwrap',
        args: [
          '--die-with-parent',
          '--ro-bind', '/', '/',
          '--bind', sessionRoot, sessionRoot,
          '--proc', '/proc',
          '--dev', '/dev',
          '--',
          command,
          ...args,
        ],
      };
    }

    if (existsOnPath('firejail')) {
      return {
        status: 'enforced',
        backend: 'firejail',
        command: 'firejail',
        args: ['--quiet', `--private=${sessionRoot}`, `--whitelist=${sessionRoot}`, '--', command, ...args],
      };
    }
  }

  // 没有任何可用后端时回退，status 标记为 unavailable，让上层决定如何处理
  return {
    status: 'unavailable',
    backend: 'none',
    command,
    args,
  };
}
