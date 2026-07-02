/**
 * 网络隔离（network isolation）
 *
 * 本模块负责把脚本子进程的网络访问能力关闭，避免沙箱内代码外联。
 * 在 Agent 场景中，tool use 调用的脚本可能来自不可信来源，因此需要默认禁网。
 */

import { spawnSync } from 'node:child_process';

/**
 * 网络隔离方案
 * status: 是否成功启用
 * backend: 使用哪种后端实现
 * command/args: 最终要执行的命令及其参数
 */
export interface NetworkIsolationPlan {
  status: 'enforced' | 'unavailable';
  backend: 'sandbox-exec' | 'unshare' | 'firejail' | 'none';
  command: string;
  args: string[];
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
 */
let sandboxExecUsableCache: boolean | null = null;

/**
 * 探测当前系统是否可用 sandbox-exec
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
 * 探测当前系统是否可用 unshare -n（进入新 network namespace）
 */
function canUseUnshare(): boolean {
  if (!existsOnPath('unshare')) return false;
  const probe = spawnSync('unshare', ['-n', 'true'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * 把原始命令包装成“带网络隔离”的命令。
 *
 * 当前支持的平台：
 * - macOS: sandbox-exec 的 deny network profile
 * - Linux: unshare -n（优先）或 firejail --net=none
 * - 其他平台: 不可用（对 script_sandbox 采取 fail-safe）
 */
export function applyNetworkIsolation(command: string, args: string[]): NetworkIsolationPlan {
  if (process.platform === 'darwin' && canUseSandboxExec()) {
    const profile = '(version 1) (deny network*)';
    return {
      status: 'enforced',
      backend: 'sandbox-exec',
      command: 'sandbox-exec',
      args: ['-p', profile, command, ...args],
    };
  }

  if (process.platform === 'linux') {
    if (canUseUnshare()) {
      return {
        status: 'enforced',
        backend: 'unshare',
        command: 'unshare',
        args: ['-n', '--', command, ...args],
      };
    }

    if (existsOnPath('firejail')) {
      return {
        status: 'enforced',
        backend: 'firejail',
        command: 'firejail',
        args: ['--quiet', '--net=none', '--', command, ...args],
      };
    }
  }

  // 没有任何可用后端时回退
  return {
    status: 'unavailable',
    backend: 'none',
    command,
    args,
  };
}
