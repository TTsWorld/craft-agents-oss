/**
 * 路径可移植性工具
 *
 * 让文件系统路径在不同机器间保持可移植。
 * 支持 ~ 和 ${HOME} 路径变量，便于跨机器兼容。
 */

import { homedir } from 'os';
import { resolve, join, normalize, isAbsolute } from 'path';
import { existsSync } from 'fs';

/**
 * 展开路径变量（~、${HOME}、$HOME）为绝对路径。
 *
 * @param inputPath - 可能包含变量的路径
 * @param basePath - 相对路径解析的基准路径（默认当前工作目录）
 * @returns 展开变量后的绝对路径
 *
 * @example
 * expandPath('~')                    // '/Users/alice'
 * expandPath('~/Documents')          // '/Users/alice/Documents'
 * expandPath('${HOME}/projects')     // '/Users/alice/projects'
 * expandPath('/absolute/path')       // '/absolute/path' (不变)
 */
export function expandPath(inputPath: string, basePath?: string): string {
  if (!inputPath) return inputPath;

  let expanded = inputPath;
  const home = homedir();

  // 单独处理 ~
  if (expanded === '~') {
    return home;
  }

  // 处理 ~/ 前缀
  if (expanded.startsWith('~/')) {
    expanded = join(home, expanded.slice(2));
  }

  // 处理 ${HOME} 和 $HOME 变量
  expanded = expanded.replace(/\$\{HOME\}/g, home);
  expanded = expanded.replace(/\$HOME(?=\/|$)/g, home);

  // 仍不是绝对路径时，从 basePath 解析
  if (!isAbsolute(expanded)) {
    const base = basePath || process.cwd();
    expanded = resolve(base, expanded);
  }

  return normalize(expanded);
}

/**
 * 将绝对路径转换为可移植形式。
 * 如果路径在用户主目录内，转换为 ~ 前缀。
 *
 * @param absolutePath - 待转换的绝对路径
 * @returns 可移植路径（主目录内用 ~ 前缀），主目录外保持原样
 *
 * @example
 * toPortablePath('/Users/alice')           // '~'
 * toPortablePath('/Users/alice/Documents') // '~/Documents'
 * toPortablePath('/var/log')               // '/var/log' (不变)
 */
export function toPortablePath(absolutePath: string): string {
  if (!absolutePath) return absolutePath;

  const home = homedir();
  const normalized = normalize(absolutePath);

  // 与主目录完全匹配
  if (normalized === home) {
    return '~';
  }

  // 路径位于主目录内（同时处理 Unix 与 Windows 分隔符）
  const homePrefix = home + '/';
  const homePrefixWin = home + '\\';

  if (normalized.startsWith(homePrefix)) {
    return '~/' + normalized.slice(homePrefix.length);
  }

  if (normalized.startsWith(homePrefixWin)) {
    return '~/' + normalized.slice(homePrefixWin.length);
  }

  // 路径在主目录外，保持绝对路径
  return normalized;
}

/**
 * 检查路径是否包含未展开的变量。
 */
export function hasPathVariables(path: string): boolean {
  if (!path) return false;
  return (
    path.startsWith('~') ||
    path.includes('${HOME}') ||
    path.includes('$HOME/')
  );
}

/**
 * 检查路径是否已经是可移植形式（~ 前缀或相对路径）。
 */
export function isPortablePath(path: string): boolean {
  if (!path) return false;
  return path.startsWith('~') || path.startsWith('./') || !isAbsolute(path);
}

// ============================================================
// 跨平台路径工具
// ============================================================

/**
 * 将路径统一为正斜杠，用于跨平台比较。
 * 在用正则或字符串比较路径前调用。
 *
 * @example
 * normalizePath('C:\\Users\\foo\\bar') // 'C:/Users/foo/bar'
 * normalizePath('/Users/foo/bar')      // '/Users/foo/bar' (不变)
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * 为跨平台比较归一化路径。
 * - 解析为绝对路径
 * - 反斜杠改为正斜杠
 * - Windows 下转小写
 */
export function normalizePathForComparison(path: string): string {
  const normalized = normalizePath(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 检查文件路径是否以某个目录路径开头（跨平台）。
 * 同时处理 Windows 反斜杠与 Unix 正斜杠。
 *
 * @example
 * pathStartsWith('C:\\Users\\foo\\file.txt', 'C:\\Users\\foo') // true
 * pathStartsWith('/home/user/file.txt', '/home/user')          // true
 * pathStartsWith('/home/user2/file.txt', '/home/user')         // false
 */
export function pathStartsWith(filePath: string, dirPath: string): boolean {
  const normalizedFile = normalizePathForComparison(filePath);
  const normalizedDir = normalizePathForComparison(dirPath);
  return normalizedFile.startsWith(normalizedDir + '/') || normalizedFile === normalizedDir;
}

/**
 * 去掉路径中的目录前缀（跨平台）。
 * 返回前缀之后的相对路径部分。
 *
 * @example
 * stripPathPrefix('/home/user/docs/file.txt', '/home/user') // 'docs/file.txt'
 * stripPathPrefix('C:\\foo\\bar\\baz.txt', 'C:\\foo')       // 'bar/baz.txt'
 */
export function stripPathPrefix(filePath: string, prefix: string): string {
  const normalizedFile = normalizePathForComparison(filePath);
  const normalizedPrefix = normalizePathForComparison(prefix);
  if (normalizedFile.startsWith(normalizedPrefix + '/')) {
    return normalizedFile.slice(normalizedPrefix.length + 1);
  }
  return filePath;
}

// ============================================================
// 打包资源解析
// ============================================================

/**
 * 打包资源的模块级根目录。
 * 在 Electron 启动时通过 setBundledAssetsRoot(__dirname) 设置一次。
 * 非 Electron 上下文（测试、开发模式）使用 process.cwd() 候选路径。
 */
let _assetsRoot: string | undefined;

/**
 * 将 Electron 主进程目录注册为打包资源根目录。
 * 应用启动时调用一次：setBundledAssetsRoot(__dirname)
 *
 * 设置后，getBundledAssetsDir('docs') 在打包应用中会解析到 `<__dirname>/resources/docs/`，
 * 不存在时回退到开发路径。
 */
export function setBundledAssetsRoot(dir: string): void {
  _assetsRoot = dir;
}

/**
 * 解析打包资源子目录的路径。
 *
 * 所有打包资源现在放在 resources/ 下，由 electron-builder 原生处理。
 * 按以下顺序尝试候选路径：
 * 1. Electron 打包应用：<assetsRoot>/resources/<subfolder>
 * 2. 开发环境：electron 应用 resources 目录（当 cwd 是 apps/electron 时）
 * 3. 开发环境：dist 输出目录（build:copy 之后）
 *
 * 返回磁盘上第一个存在的候选路径，都找不到返回 undefined。
 *
 * @param subfolder - 资源子目录名（如 'docs'、'tool-icons'、'themes'、'permissions'）
 */
export function getBundledAssetsDir(subfolder: string): string | undefined {
  const candidates = [
    // Electron 打包应用（启动时通过 setBundledAssetsRoot 设置）
    ...(_assetsRoot ? [join(_assetsRoot, 'resources', subfolder)] : []),
    // 开发环境：electron 应用 resources 目录（cwd 为 apps/electron 时）
    join(process.cwd(), 'resources', subfolder),
    // 开发环境：dist 输出（build:copy 后）
    join(process.cwd(), 'dist', 'resources', subfolder),
  ];
  return candidates.find(p => existsSync(p));
}
