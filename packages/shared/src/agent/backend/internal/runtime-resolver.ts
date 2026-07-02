/**
 * 本文件是“后端运行时路径解析器”（runtime resolver）。
 *
 * 职责：根据宿主运行时上下文（host runtime context，例如是否打包、当前平台/架构、
 * 应用根目录 appRootPath、Electron resourcesPath 等），解析后端真正运行所需的
 * 各种外部二进制 / bundle 的绝对路径。包括：
 *   - Claude Agent SDK 的原生 `claude` 二进制（自 SDK 0.2.113 起为 per-platform 原生可执行）
 *   - 网络拦截器 interceptor bundle（Pi 子进程通过 Bun --preload 预加载）
 *   - 各 MCP server bundle（session-mcp-server / bridge-mcp-server / pi-agent-server）
 *   - Bun 运行时（bundledRuntimePath）
 *   - ripgrep（搜索服务用到）
 *
 * 它同时服务于两条后端路径：
 *   1. ClaudeAgent —— 直接 spawn 原生 `claude` 二进制；
 *   2. PiAgent —— 用 Bun 运行时启动 pi-agent-server，并通过 interceptor bundle 注入网络拦截。
 *
 * 部署形态对应：
 *   - dev：monorepo 源码形态（appRootPath 在仓库内）；
 *   - packaged：打包后的 .app / .dmg，二进制位于 Resources 目录；
 *   - headless server：Docker 容器（可能 Alpine/musl）。
 *
 * Go 类比：本文件类似 Go 里结合 build 约束（platform/arch）+ 路径探测的工具，
 * `process.platform` / `process.arch` 相当于 Go 的 `runtime.GOOS` / `runtime.GOARCH`，
 * `existsSync` 类似 `os.Stat`，`execFileSync` 类似 `exec.Command(...).Output()`，
 * `dirname` / `join` / `resolve` 类似 Go 的 `path/filepath` 包。
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { BackendHostRuntimeContext } from '../types.ts';
import { setPathToClaudeCodeExecutable } from '../../options.ts';

/**
 * 当该环境变量被设置时，解析器会从 .app bundle 继续向上查找，以便在 monorepo
 * 中或系统 PATH 上找到 SDK、interceptor 与 bun。
 * 面向本地 `electron:dist:mac` 构建（即跳过 `build-dmg.sh` 的临时开发构建）使用。
 */
const IS_DEV_RUNTIME = !!process.env.CRAFT_DEV_RUNTIME;

export interface ResolvedBackendRuntimePaths {
  /**
   * 原生 `claude` 二进制文件的绝对路径（SDK ≥ 0.2.113）。
   * 打包构建中，这是从 `node_modules/@anthropic-ai/claude-agent-sdk-{platform}-{arch}/`
   * 复制出来的平台相关二进制。字段名保留 `claudeCliPath` 以兼容旧代码；
   * 语义上它就是 SDK 可执行文件（无论是 JS 还是原生二进制）。
   */
  claudeCliPath?: string;
  /**
   * 预加载进 **Pi** 子进程的网络拦截器 source/bundle 路径。
   * Claude 不再使用 —— 新版原生 SDK 二进制不支持 `--preload`。
   */
  interceptorBundlePath?: string;
  sessionServerPath?: string;
  bridgeServerPath?: string;
  piServerPath?: string;
  nodeRuntimePath?: string;
  bundledRuntimePath?: string;
}

export interface ResolvedBackendHostTooling {
  ripgrepPath?: string;
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 从 `base` 开始向上遍历目录，在每层检查 `join(ancestor, relativePath)` 是否存在。
 * 到达 `maxLevels` 层或文件系统根目录时停止。
 */
function resolveUpwards(base: string, relativePath: string, maxLevels = 4): string | undefined {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * 解析打包/运行时使用的 Bun（或 Node）可执行文件路径。
 *
 * 查找顺序：
 *   1. `<appRoot>/vendor/bun/bun(.exe)`（打包应用自带）；
 *   2. 非打包形态下回退到 PATH 上的系统 bun。
 *
 * 打包应用必须从自带 vendor 目录取，避免调用不兼容的系统 bun。
 */
function resolveBundledRuntimePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunBasePath = process.platform === 'win32'
    ? (hostRuntime.resourcesPath || hostRuntime.appRootPath)
    : hostRuntime.appRootPath;
  const bunPath = join(bunBasePath, 'vendor', 'bun', bunBinary);
  if (existsSync(bunPath)) return bunPath;

  // 非打包形态（headless server、dev mode）：回退到 PATH 上的系统 bun。
  // 打包应用必须自带 bun —— 绝不要从 PATH 解析，避免拿到不兼容的系统版本。
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemBun = execFileSync(whichCmd, ['bun'], { encoding: 'utf-8' }).trim();
      if (systemBun && existsSync(systemBun)) return systemBun;
    } catch { /* system bun not found */ }
  }
  return undefined;
}

/**
 * 计算 Claude Agent SDK（≥ 0.2.113）按平台分发的 optional-dependency 包名，
 * 例如 `claude-agent-sdk-darwin-arm64`。
 *
 * 关于 Linux musl 的说明：这里返回 glibc 变体。AppImage 目标平台是 glibc，
 * 这也是桌面端唯一分发的 Linux 形态。Docker 中的 headless server
 *（可能跑在 Alpine/musl 上）是另一回事，留到 server 打包阶段再处理。
 */
function platformBinaryPkg(): string | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `claude-agent-sdk-darwin-${arch}`;
  if (process.platform === 'win32') return `claude-agent-sdk-win32-${arch}`;
  if (process.platform === 'linux') return `claude-agent-sdk-linux-${arch}`;
  return undefined;
}

/**
 * 返回当前平台下 Claude SDK 原生可执行文件的文件名。
 * Windows 为 `claude.exe`，其它平台为 `claude`。
 */
function nativeBinaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

/**
 * 解析 SDK 作为 optional dependency 分发的平台相关原生 `claude` 二进制。
 * 替代旧的 `cli.js` 查找逻辑（SDK ≥ 0.2.113）。
 *
 * 查找顺序：
 *   1. 稳定构建别名 `@anthropic-ai/claude-agent-sdk-binary` —— 平台构建脚本
 *     （build-dmg.sh 等）在 electron-builder 运行前会填充这个路径，因此打包构建
 *      总能在这个与架构无关的固定位置找到二进制。
 *   2. 按平台分发的 optional-dep 包名（如 `-darwin-arm64`）—— 普通 `bun install`
 *      在 dev / monorepo / CI 环境下产生的路径。
 *   3. dev-runtime 向上遍历：针对临时本地构建（`electron:dist:dev:mac`）在以上
 *      两种查找中继续向上搜索。
 */
function resolveClaudeBinaryPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const binaryName = nativeBinaryName();
  const aliasRel = join('node_modules', '@anthropic-ai', 'claude-agent-sdk-binary', binaryName);
  const pkg = platformBinaryPkg();
  const platformRel = pkg
    ? join('node_modules', '@anthropic-ai', pkg, binaryName)
    : undefined;

  const candidates: string[] = [
    join(hostRuntime.appRootPath, aliasRel),
    join(hostRuntime.appRootPath, '..', '..', aliasRel),
  ];
  if (platformRel) {
    candidates.push(
      join(hostRuntime.appRootPath, platformRel),
      join(hostRuntime.appRootPath, '..', '..', platformRel),
    );
  }

  const result = firstExistingPath(candidates);
  if (result) return result;

  // 开发运行时：从 .app bundle 继续向上查找，直到 monorepo 根目录
  if (IS_DEV_RUNTIME) {
    return resolveUpwards(hostRuntime.appRootPath, aliasRel, 10)
      ?? (platformRel ? resolveUpwards(hostRuntime.appRootPath, platformRel, 10) : undefined);
  }
  return undefined;
}

/**
 * 解析网络拦截器 bundle 路径。
 *
 * 该 bundle 通过 `--preload` 注入 Pi 子进程，用于拦截和记录网络请求。
 * 非打包环境下优先使用 TypeScript 源码以便热加载；打包构建走预构建的
 * `dist/interceptor.cjs`。
 */
function resolveInterceptorBundlePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  if (hostRuntime.interceptorBundlePath && existsSync(hostRuntime.interceptorBundlePath)) {
    return hostRuntime.interceptorBundlePath;
  }

  // dev / monorepo 运行时优先用 TypeScript 源码，这样无需手动 `bun run build:interceptor`
  // 就能热加载改动。Bun 原生支持 `--require <file>.ts`。打包构建总是走预构建的
  // `dist/interceptor.cjs` bundle。
  if (!hostRuntime.isPackaged) {
    const source = resolveUpwards(
      hostRuntime.appRootPath,
      join('packages', 'shared', 'src', 'unified-network-interceptor.ts'),
      10,
    );
    if (source) return source;
  }

  return resolveUpwards(hostRuntime.appRootPath, join('dist', 'interceptor.cjs'))
    ?? resolveUpwards(hostRuntime.appRootPath, join('apps', 'electron', 'dist', 'interceptor.cjs'));
}

/**
 * 解析某个 MCP server（session-mcp-server / bridge-mcp-server / pi-agent-server）
 * 的入口文件路径。
 */
function resolveServerPath(hostRuntime: BackendHostRuntimeContext, serverName: string): string | undefined {
  if (hostRuntime.isPackaged) {
    return firstExistingPath([
      join(hostRuntime.appRootPath, 'resources', serverName, 'index.js'),
      join(hostRuntime.appRootPath, 'dist', 'resources', serverName, 'index.js'),
    ]);
  }
  return resolveUpwards(
    hostRuntime.appRootPath,
    join('packages', serverName, 'dist', 'index.js'),
  );
}

/**
 * 定位 ripgrep 可执行文件。SDK 0.2.113 起不再自带 `vendor/ripgrep/<platform>/rg`
 *（该二进制已编译进原生 `claude` 可执行文件），但 `packages/server-core/src/services/search.ts`
 * 里的搜索服务仍直接调用 ripgrep，因此需要从 `@vscode/ripgrep` 查找。
 */
function resolveRipgrepPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const ripgrepRelative = join('node_modules', '@vscode', 'ripgrep', 'bin', binaryName);

  if (hostRuntime.isPackaged) {
    const packaged = join(hostRuntime.appRootPath, ripgrepRelative);
    if (existsSync(packaged)) return packaged;
  }

  const fromHostRoot = resolveUpwards(hostRuntime.appRootPath, ripgrepRelative, 10);
  if (fromHostRoot) return fromHostRoot;

  const cwdFallback = join(process.cwd(), ripgrepRelative);
  if (existsSync(cwdFallback)) return cwdFallback;

  // 非打包形态（headless server、dev mode）：回退到 PATH 上的系统 rg。
  // 打包应用只能使用自带的 vendored 二进制 —— 绝不要从 PATH 解析，避免拿到不兼容版本。
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemRg = execFileSync(whichCmd, ['rg'], { encoding: 'utf-8' }).trim();
      if (systemRg && existsSync(systemRg)) return systemRg;
    } catch { /* system rg not found */ }
  }

  return undefined;
}

/**
 * 解析后端所需的全部运行时路径，返回给 driver 用于构建子进程运行环境。
 *
 * 包括：Claude 原生二进制、interceptor bundle、各 MCP server 入口、
 * Bun/Node 运行时路径等。
 */
export function resolveBackendRuntimePaths(hostRuntime: BackendHostRuntimeContext): ResolvedBackendRuntimePaths {
  const bundledRuntimePath = hostRuntime.nodeRuntimePath || resolveBundledRuntimePath(hostRuntime);

  return {
    claudeCliPath: resolveClaudeBinaryPath(hostRuntime),
    interceptorBundlePath: resolveInterceptorBundlePath(hostRuntime),
    sessionServerPath: resolveServerPath(hostRuntime, 'session-mcp-server'),
    bridgeServerPath: resolveServerPath(hostRuntime, 'bridge-mcp-server'),
    piServerPath: resolveServerPath(hostRuntime, 'pi-agent-server'),
    nodeRuntimePath: hostRuntime.nodeRuntimePath || bundledRuntimePath || process.execPath,
    bundledRuntimePath,
  };
}

/**
 * 解析宿主端工具路径（目前只有 ripgrep）。
 */
export function resolveBackendHostTooling(hostRuntime: BackendHostRuntimeContext): ResolvedBackendHostTooling {
  return {
    ripgrepPath: resolveRipgrepPath(hostRuntime),
  };
}

/**
 * 根据 host runtime 上下文配置 SDK 全局参数。
 *
 * SDK 0.2.113 起使用原生二进制；我们唯一需要覆盖的是 `pathToClaudeCodeExecutable`。
 * 以前在这里处理的 Bun 可执行文件 / `--preload` 拦截器机制已不再适用 ——
 * 原生二进制不接受 Bun 专属标志。
 *
 * `strict` 为 true（默认）时，找不到 SDK 二进制会抛错；
 * `strict` 为 false 时，缺失路径会被静默跳过（SDK 会尝试自己的 optional-dep
 * node_modules 自动发现）。
 */
export function applyAnthropicRuntimeBootstrap(
  hostRuntime: BackendHostRuntimeContext,
  paths: ResolvedBackendRuntimePaths,
  options?: { strict?: boolean },
): void {
  const strict = options?.strict ?? true;

  if (paths.claudeCliPath) {
    setPathToClaudeCodeExecutable(paths.claudeCliPath);
  } else if (strict) {
    throw new Error('Claude Agent SDK native binary not found. The app package may be corrupted.');
  }
}
