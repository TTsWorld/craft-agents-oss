/**
 * PathProcessor - 路径展开与规范化
 *
 * 【中文学习注释 - 文件级】
 * 本文件是 Agent 核心的“路径工具箱”。LLM 生成的路径可能带 ~/、$HOME、相对路径、反斜杠等，
 * 在真正交给文件系统或 SDK 前必须做统一处理。类比 Golang：相当于 path/filepath + os.UserHomeDir 的封装层。
 *
 * 核心职责：
 * 1. 路径展开：把 ~/file.txt 展开为 /Users/xxx/file.txt，$HOME 同理。
 * 2. 路径规范化：统一为正斜杠、绝对路径、比较用归一化形式，解决 Windows/macOS/Linux 差异。
 * 3. 工作区相对路径：支持判断文件是否在某个目录下（pathStartsWith）。
 * 4. 配置文件检测：根据路径正则识别是否是需要写前校验的配置文件。
 *
 * TypeScript 注意点：
 * - 通过 export { expandPath, ... } 从底层 utils/paths.ts 再导出，方便调用方只 import 本文件。
 * - RegExp[] 数组常量大写命名是项目约定，类似 Golang 的 const 包级变量。
 */

import { homedir } from 'os';
import { resolve, isAbsolute, normalize as normalizePosix, basename, dirname } from 'path';
import {
  expandPath,
  normalizePath,
  normalizePathForComparison,
  pathStartsWith,
  toPortablePath,
} from '../../utils/paths.ts';
import type { PathProcessorConfig } from './types.ts';

// 从底层 utils/paths.ts 再导出常用路径工具，方便调用方只 import 本文件
export { expandPath, normalizePath, pathStartsWith, toPortablePath };

/**
 * 已知可能需要写前校验的配置文件路径正则。
 * 这些文件格式固定（JSON / TOML / YAML），一旦写坏可能导致应用无法启动。
 */
const CONFIG_FILE_PATTERNS = [
  // Craft Agent 配置
  /\.craft-agent\/.*\/(config|permissions|theme|guide|labels|statuses)\.json$/,
  /\.craft-agent\/config\.json$/,
  /\.craft-agent\/preferences\.json$/,
  /\.craft-agent\/.*\/SKILL\.md$/,
  // 通用配置文件
  /package\.json$/,
  /tsconfig\.json$/,
  /\.eslintrc(\.json)?$/,
  /\.prettierrc(\.json)?$/,
  /pyproject\.toml$/,
  /Cargo\.toml$/,
  /\.env(\..+)?$/,
];

/**
 * PathProcessor：为 agent 工具处理提供路径工具。
 *
 * 用法示例：
 * ```typescript
 * const pathProcessor = new PathProcessor();
 *
 * // 展开工具入参中的用户主目录路径
 * const expandedPath = pathProcessor.expandPath('~/Documents/file.txt');
 *
 * // 判断文件是否需要写前校验
 * if (pathProcessor.isConfigFile(filePath)) {
 *   // 写入前先校验
 * }
 * ```
 */
export class PathProcessor {
  private homeDir: string;

  constructor(config: PathProcessorConfig = {}) {
    this.homeDir = config.homeDir ?? homedir();
  }

  // ============================================================
  // 路径展开
  // ============================================================

  /**
   * 把 ~ 与 $HOME 变量展开为绝对路径。
   *
   * 说明：~/Documents -> /Users/xxx/Documents。LLM 可能生成带 ~ 的路径，
   * 而 Node.js 的 fs API 默认不认识 ~，所以工具调用前必须先展开。
   * 底层委托给 utils/paths.ts 的 expandPath，这里做 class 封装以便注入 homeDir。
   *
   * @param path - 可能包含 ~ 或 $HOME 的路径
   * @param basePath - 相对路径解析的基准目录（默认当前工作目录）
   * @returns 展开后的绝对路径
   */
  expandPath(path: string, basePath?: string): string {
    return expandPath(path, basePath);
  }

  /**
   * 简单版 ~ 展开（仅处理以 ~ 开头的路径，不处理 $HOME 变量）。
   *
   * @param path - 可能以 ~ 开头的路径
   * @returns 展开后的路径
   */
  expandTilde(path: string): string {
    if (path === '~') {
      return this.homeDir;
    }
    if (path.startsWith('~/')) {
      return this.homeDir + path.slice(1);
    }
    return path;
  }

  // ============================================================
  // 路径规范化
  // ============================================================

  /**
   * 把路径统一为正斜杠，用于跨平台比较。
   *
   * @param path - 要规范化的路径
   * @returns 统一为正斜杠的路径
   */
  normalize(path: string): string {
    return normalizePath(path);
  }

  /**
   * 对路径做比较级规范化：解析为绝对路径、统一分隔符、Windows 下转小写。
   */
  normalizeForComparison(path: string): string {
    return normalizePathForComparison(path);
  }
  /**
   * 把绝对路径转成可移植形式（如果在 home 目录下则改用 ~ 前缀）。
   *
   * @param absolutePath - 要转换的绝对路径
   * @returns 可移植路径
   */
  toPortable(absolutePath: string): string {
    return toPortablePath(absolutePath);
  }

  /**
   * 判断文件路径是否在指定目录下。
   *
   * @param filePath - 要检查的文件路径
   * @param dirPath - 目录路径
   * @returns 文件在目录下时返回 true
   */
  isWithinDirectory(filePath: string, dirPath: string): boolean {
    return pathStartsWith(filePath, dirPath);
  }

  // ============================================================
  // 配置文件检测
  // ============================================================

  /**
   * 判断路径是否指向需要写前校验的配置文件。
   *
   * 说明：写配置文件前要先校验，避免把非法 JSON/TOML/YAML 写到磁盘导致应用崩溃。
   * 这里用一组正则匹配常见配置文件路径，包括 .craft-agent 内部配置和通用的 package.json、tsconfig.json 等。
   * 与 Golang 类比：类似根据文件后缀或路径做路由分发，决定走哪个 validator。
   *
   * @param filePath - 要检查的路径
   * @returns 是配置文件时返回 true
   */
  isConfigFile(filePath: string): boolean {
    const normalized = this.normalizeForComparison(this.expandPath(filePath));
    return CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  /**
   * 获取配置文件正则列表（调试用）。
   */
  getConfigPatterns(): RegExp[] {
    return [...CONFIG_FILE_PATTERNS];
  }

  /**
   * 根据扩展名判断配置文件的类型。
   *
   * @param filePath - 要检查的路径
   * @returns 配置类型；不是已知配置格式则返回 null
   */
  getConfigType(filePath: string): 'json' | 'toml' | 'yaml' | 'env' | 'md' | null {
    const ext = basename(filePath).toLowerCase();

    if (ext.endsWith('.json')) return 'json';
    if (ext.endsWith('.toml')) return 'toml';
    if (ext.endsWith('.yaml') || ext.endsWith('.yml')) return 'yaml';
    if (ext.startsWith('.env')) return 'env';
    if (ext.endsWith('.md')) return 'md';

    return null;
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 获取用户主目录。
   */
  getHomeDir(): string {
    return this.homeDir;
  }

  /**
   * 从路径中提取文件名。
   */
  getBasename(path: string): string {
    return basename(path);
  }

  /**
   * 从路径中提取所在目录。
   */
  getDirname(path: string): string {
    return dirname(path);
  }

  /**
   * 判断路径是否为绝对路径。
   */
  isAbsolute(path: string): boolean {
    return isAbsolute(path);
  }

  /**
   * 基于基准目录解析路径。
   */
  resolve(basePath: string, ...paths: string[]): string {
    return resolve(basePath, ...paths);
  }
}
