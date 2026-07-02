/**
 * 脚本运行时解析（resolve script runtime）
 *
 * Agent 的 tool use 会调用外部脚本（python3 / node / bun）。
 * 本模块负责根据当前环境（开发环境、打包后的 Electron 应用、环境变量覆盖等）
 * 找到可用的运行时命令及固定参数前缀。
 *
 * 解析优先级：
 * 1. 环境变量显式指定（CRAFT_UV / CRAFT_NODE / CRAFT_BUN）
 * 2. 应用内置（bundled）二进制
 * 3. 开发模式下回退到 PATH 查找
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * 支持的脚本语言类型
 * 这里用 TS 的联合类型（union type），类似 Golang 里自定义 string 枚举。
 */
export type ScriptRuntimeLanguage = 'python3' | 'node' | 'bun';

/**
 * 解析结果：最终执行命令、固定前缀参数、来源
 */
export interface ResolvedScriptRuntime {
  command: string;
  argsPrefix: string[];
  source: 'env' | 'bundled' | 'path';
}

/**
 * 解析上下文，用于在测试或 Electron 环境中注入路径。
 */
export interface ResolveScriptRuntimeContext {
  /**
   * 宿主应用是否已打包。默认读取 CRAFT_IS_PACKAGED=1。
   * 打包模式下默认禁止通过 PATH 回退查找，以减少分发时对外部环境的依赖。
   */
  isPackaged?: boolean;

  /**
   * 可选的显式应用根路径（通常是 Electron 的 app.getAppPath()）。
   */
  appRootPath?: string;

  /**
   * Electron 启动时使用的资源根目录。
   * 常见情况：
   * - 打包后：<process.resourcesPath>/app
   * - 开发时：<repo>/apps/electron
   */
  resourcesBasePath?: string;
}

/**
 * 在 PATH 中查找二进制，返回第一条结果或 null
 */
function resolveBinaryOnPath(binary: string): string | null {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [binary], { encoding: 'utf8' });

  if (result.status !== 0) {
    return null;
  }

  // 按行拆分，trim 后取第一个非空行
  const firstMatch = result.stdout
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  return firstMatch ?? null;
}

/**
 * 从候选路径中返回第一个真实存在的路径
 */
function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolvedCandidate = resolve(candidate);
    if (existsSync(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }
  return null;
}

/**
 * 根据当前平台与 CPU 架构生成目录名，例如 "darwin-arm64"、"linux-x64"。
 */
function getPlatformRuntimeDir(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * 推断是否处于打包模式：上下文显式指定优先，否则读环境变量。
 */
function inferPackagedMode(ctx?: ResolveScriptRuntimeContext): boolean {
  if (typeof ctx?.isPackaged === 'boolean') return ctx.isPackaged;
  return process.env.CRAFT_IS_PACKAGED === '1';
}

/**
 * 读取 Electron 的 process.resourcesPath（NodeJS.Process 本身没有该字段，
 * 所以这里用交叉类型 & 扩展属性后读取）。
 */
function getProcessResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

/**
 * 解析资源根目录：优先使用显式配置或环境变量，否则探测 Electron resourcesPath/app。
 */
function resolveResourcesBase(ctx?: ResolveScriptRuntimeContext): string | null {
  const explicit = ctx?.resourcesBasePath || process.env.CRAFT_RESOURCES_BASE;
  if (explicit) return resolve(explicit);

  const resourcesPath = getProcessResourcesPath();
  if (resourcesPath) {
    const packagedCandidate = join(resourcesPath, 'app');
    if (existsSync(packagedCandidate)) return packagedCandidate;
  }

  return null;
}

/**
 * 解析应用根目录：优先使用显式配置或环境变量。
 */
function resolveAppRoot(ctx?: ResolveScriptRuntimeContext): string | null {
  const explicit = ctx?.appRootPath || process.env.CRAFT_APP_ROOT;
  return explicit ? resolve(explicit) : null;
}

/**
 * 查找内置的 uv 二进制。
 * uv 是 Python 包管理器/运行时入口，用于执行 Python 脚本。
 */
function resolveBundledUv(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const platformDir = getPlatformRuntimeDir();
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  const resourcesPath = getProcessResourcesPath();

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'resources', 'bin', platformDir, binary) : '',
    appRoot ? join(appRoot, 'resources', 'bin', platformDir, binary) : '',
    resourcesPath ? join(resourcesPath, 'app', 'resources', 'bin', platformDir, binary) : '',
  ]);
}

/**
 * 查找内置的 Node.js 二进制。
 */
function resolveBundledNode(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'vendor', 'node', binary) : '',
    appRoot ? join(appRoot, 'vendor', 'node', binary) : '',
  ]);
}

/**
 * 查找内置的 Bun 二进制。
 */
function resolveBundledBun(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'vendor', 'bun', binary) : '',
    appRoot ? join(appRoot, 'vendor', 'bun', binary) : '',
  ]);
}

/**
 * 打包模式下校验通过环境变量指定的运行时路径：
 * - 必须是绝对路径，或至少包含路径分隔符（不能是相对命令名）
 * - 必须真实存在
 *
 * 这样可避免打包应用依赖用户 PATH，导致分发后找不到运行时或找到错误版本。
 */
function validatePackagedEnvRuntime(command: string, label: string): string {
  const hasPathSeparator = command.includes('/') || command.includes('\\');

  if (!isAbsolute(command) && !hasPathSeparator) {
    throw new Error(
      `${label} runtime from env is not an absolute/bundled path (${command}). ` +
      'Packaged builds do not allow PATH-based runtime resolution. Configure an absolute CRAFT_* path or ship a bundled runtime.'
    );
  }

  const resolvedCommand = resolve(command);
  if (!existsSync(resolvedCommand)) {
    throw new Error(
      `${label} runtime from env does not exist: ${resolvedCommand}. ` +
      'Configure a valid absolute CRAFT_* path or ship a bundled runtime.'
    );
  }

  return resolvedCommand;
}

/**
 * 解析脚本运行时：返回命令和固定参数前缀。
 *
 * 按以下顺序解析：
 * - 环境变量覆盖（CRAFT_UV / CRAFT_NODE / CRAFT_BUN）
 * - 内置二进制（打包模式常用）
 * - PATH 回退（仅开发模式）
 */
export function resolveScriptRuntime(
  language: ScriptRuntimeLanguage,
  ctx?: ResolveScriptRuntimeContext,
): ResolvedScriptRuntime {
  const isPackaged = inferPackagedMode(ctx);

  if (language === 'python3') {
    if (process.env.CRAFT_UV) {
      const cmd = isPackaged
        ? validatePackagedEnvRuntime(process.env.CRAFT_UV, 'Python/uv')
        : process.env.CRAFT_UV;

      return {
        command: cmd,
        argsPrefix: ['run', '--python', '3.12'],
        source: 'env',
      };
    }

    const bundledUv = resolveBundledUv(ctx);
    if (bundledUv) {
      return {
        command: bundledUv,
        argsPrefix: ['run', '--python', '3.12'],
        source: 'bundled',
      };
    }

    // 非打包模式下才允许到 PATH 里找 uv
    if (!isPackaged) {
      const uvPath = resolveBinaryOnPath('uv');
      if (uvPath) {
        return {
          command: uvPath,
          argsPrefix: ['run', '--python', '3.12'],
          source: 'path',
        };
      }
    }

    throw new Error(
      isPackaged
        ? 'Python runtime unavailable in packaged app: uv was not found in env or bundled resources.'
        : 'Python runtime unavailable: uv was not found. Configure CRAFT_UV or install uv on PATH.'
    );
  }

  if (language === 'node') {
    if (process.env.CRAFT_NODE) {
      const cmd = isPackaged
        ? validatePackagedEnvRuntime(process.env.CRAFT_NODE, 'Node')
        : process.env.CRAFT_NODE;
      return { command: cmd, argsPrefix: [], source: 'env' };
    }

    const bundledNode = resolveBundledNode(ctx);
    if (bundledNode) {
      return { command: bundledNode, argsPrefix: [], source: 'bundled' };
    }

    if (!isPackaged) {
      const nodePath = resolveBinaryOnPath('node');
      if (nodePath) {
        return { command: nodePath, argsPrefix: [], source: 'path' };
      }
    }

    throw new Error(
      isPackaged
        ? 'Node runtime unavailable in packaged app: node was not found in env or bundled resources.'
        : 'Node runtime unavailable: configure CRAFT_NODE or install node on PATH.'
    );
  }

  // 默认处理 bun（当 language 不为 python3 或 node 时）
  if (process.env.CRAFT_BUN) {
    const cmd = isPackaged
      ? validatePackagedEnvRuntime(process.env.CRAFT_BUN, 'Bun')
      : process.env.CRAFT_BUN;
    return { command: cmd, argsPrefix: [], source: 'env' };
  }

  const bundledBun = resolveBundledBun(ctx);
  if (bundledBun) {
    return { command: bundledBun, argsPrefix: [], source: 'bundled' };
  }

  if (!isPackaged) {
    const bunPath = resolveBinaryOnPath('bun');
    if (bunPath) {
      return { command: bunPath, argsPrefix: [], source: 'path' };
    }
  }

  throw new Error(
    isPackaged
      ? 'Bun runtime unavailable in packaged app: bun was not found in env or bundled resources.'
      : 'Bun runtime unavailable: configure CRAFT_BUN or install bun on PATH.'
  );
}
