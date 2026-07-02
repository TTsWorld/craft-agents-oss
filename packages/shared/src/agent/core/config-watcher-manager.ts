/**
 * ConfigWatcherManager - 配置文件热重载管理器
 *
 * 【中文学习注释 - 文件级】
 * 本文件是 Agent 运行时的“配置监听层”。它对底层 ConfigWatcher（基于 fs.watch 的文件监听）
 * 做一层面向 agent 的薄封装，把原始事件转换成 source / skill / permissions 等领域语义的回调，
 * 让 ClaudeAgent 和 PiAgent 用同一套接口拿到配置变更通知，从而实现“改完配置不重启即生效”。
 *
 * Agent 概念说明（面向初学者）：
 * - source：外部数据源（如 MCP 服务器、API、本地文件夹），agent 通过它读取上下文。
 * - skill：可挂载的“技能”（SKILL.md 等），决定 agent 能调用哪些工具或提示词模板。
 * - workspace：一个工作区目录，下面挂多个 session；source/skill 配置都归属于 workspace。
 * - headless 模式：无 UI 的运行模式（如 CLI / 后台服务），通常不需要热重载，直接跳过以减少开销。
 *
 * 与 Golang 类比：相当于在 fsnotify 之上又包了一层“业务事件分发器”，
 * 把底层的 Create/Write/Remove 事件归并成“某个 source 被更新了”这种业务事件。
 *
 * TypeScript 语法提示：
 * - interface 里 `onXxx?: (...) => void` 的 `?` 表示可选字段，调用方可以只实现关心的回调。
 * - `this.callbacks.onSourceChange?.(...)` 的 `?.` 是可选链，回调未注册时直接短路返回 undefined，避免 TypeError。
 * - `LoadedSource | null` 是联合类型：source 可能为 null（表示被删除），类似 Go 里用指针 + nil 表达。
 */

import {
  ConfigWatcher,
  createConfigWatcher,
  type ConfigWatcherCallbacks,
} from '../../config/watcher.ts';
import type { LoadedSource } from '../../sources/types.ts';
import type { LoadedSkill } from '../../skills/types.ts';
import type { ValidationResult } from '../../config/validators.ts';
import { debug } from '../../utils/debug.ts';

// ============================================================
// 类型定义
// ============================================================

/**
 * 配置变更回调集合（面向 agent 简化后的接口）。
 * 所有回调都是可选的，调用方按需实现即可。
 */
export interface ConfigWatcherManagerCallbacks {
  /**
   * 单个 source 配置变更（新增/更新/删除）。
   * @param slug - source 的唯一标识
   * @param source - 更新后的 source；为 null 表示该 source 已被删除
   */
  onSourceChange?: (slug: string, source: LoadedSource | null) => void;

  /**
   * source 列表整体变更（如新增/删除了 source 文件夹）。
   * @param sources - 当前所有 source
   */
  onSourcesListChange?: (sources: LoadedSource[]) => void;

  /**
   * 单个 skill 配置变更。
   * @param slug - skill 的唯一标识
   * @param skill - 更新后的 skill；为 null 表示已删除
   */
  onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;

  /**
   * skill 列表整体变更。
   * @param skills - 当前所有 skill
   */
  onSkillsListChange?: (skills: LoadedSkill[]) => void;

  /**
   * workspace 级别权限配置变更。
   * @param workspaceId - 工作区 ID
   */
  onWorkspacePermissionsChange?: (workspaceId: string) => void;

  /**
   * 某个 source 的权限配置变更。
   * @param sourceSlug - source 的唯一标识
   */
  onSourcePermissionsChange?: (sourceSlug: string) => void;

  /**
   * 应用默认（app 级别）权限配置变更。
   */
  onDefaultPermissionsChange?: () => void;

  /**
   * 配置文件加载/校验时发生错误。
   * @param file - 相对配置根目录的文件路径
   * @param errors - 校验错误信息数组
   */
  onValidationError?: (file: string, errors: string[]) => void;

  /**
   * 读取/解析配置文件时发生异常。
   * @param file - 相对配置根目录的文件路径
   * @param error - 抛出的错误对象
   */
  onError?: (file: string, error: Error) => void;
}

/**
 * ConfigWatcherManager 的构造配置。
 */
export interface ConfigWatcherManagerConfig {
  /**
   * 要监听的 workspace 根路径（可以是 workspace ID 或绝对路径）。
   */
  workspaceRootPath: string;

  /**
   * 是否处于 headless 模式。headless 下默认不监听以降低开销。
   */
  isHeadless?: boolean;

  /**
   * 调试日志回调（可选）。
   */
  onDebug?: (message: string) => void;
}

// ============================================================
// ConfigWatcherManager 类
// ============================================================

/**
 * 管理 agent 配置文件监听，提供热重载能力。
 *
 * 在底层 ConfigWatcher 之上做封装，提供：
 * - 只暴露 agent 关心的回调（屏蔽底层无关事件）
 * - 处理 headless 模式（直接 no-op）
 * - 统一的调试日志前缀
 */
export class ConfigWatcherManager {
  // 底层 watcher 实例；null 表示尚未启动或已停止
  private watcher: ConfigWatcher | null = null;
  private workspaceRootPath: string;
  private isHeadless: boolean;
  private callbacks: ConfigWatcherManagerCallbacks;
  // 调试回调；为 null 时只走全局 debug() 通道
  private onDebugCallback: ((message: string) => void) | null;

  constructor(config: ConfigWatcherManagerConfig, callbacks: ConfigWatcherManagerCallbacks = {}) {
    this.workspaceRootPath = config.workspaceRootPath;
    // `??` 是空值合并：仅当左侧为 null/undefined 时取右侧默认值 false
    this.isHeadless = config.isHeadless ?? false;
    this.callbacks = callbacks;
    this.onDebugCallback = config.onDebug ?? null;
  }

  /**
   * 启动配置监听。
   * 已运行或处于 headless 模式时为 no-op（空操作）。
   */
  start(): void {
    if (this.watcher) {
      return; // 已在运行，避免重复启动
    }

    if (this.isHeadless) {
      this.debug('Config watching disabled in headless mode');
      return;
    }

    // 构造底层 ConfigWatcher 需要的回调集合，把每个事件都先打 debug 日志，再转发给 agent 注册的回调
    const watcherCallbacks: ConfigWatcherCallbacks = {
      onSourceChange: (slug, source) => {
        this.debug(`Source changed: ${slug} ${source ? 'updated' : 'deleted'}`);
        this.callbacks.onSourceChange?.(slug, source);
      },

      onSourcesListChange: (sources) => {
        this.debug(`Sources list changed: ${sources.length} sources`);
        this.callbacks.onSourcesListChange?.(sources);
      },

      onSkillChange: (slug, skill) => {
        this.debug(`Skill changed: ${slug} ${skill ? 'updated' : 'deleted'}`);
        this.callbacks.onSkillChange?.(slug, skill);
      },

      onSkillsListChange: (skills) => {
        this.debug(`Skills list changed: ${skills.length} skills`);
        this.callbacks.onSkillsListChange?.(skills);
      },

      onWorkspacePermissionsChange: (workspaceId) => {
        this.debug(`Workspace permissions changed: ${workspaceId}`);
        this.callbacks.onWorkspacePermissionsChange?.(workspaceId);
      },

      onSourcePermissionsChange: (sourceSlug) => {
        this.debug(`Source permissions changed: ${sourceSlug}`);
        this.callbacks.onSourcePermissionsChange?.(sourceSlug);
      },

      onDefaultPermissionsChange: () => {
        this.debug('Default permissions changed');
        this.callbacks.onDefaultPermissionsChange?.();
      },

      onValidationError: (file, result) => {
        // 把 ValidationIssue 对象映射成纯字符串数组，方便 agent 侧消费
        const errorMessages = result.errors.map(e => e.message);
        this.debug(`Config validation error: ${file} - ${errorMessages.join(', ')}`);
        this.callbacks.onValidationError?.(file, errorMessages);
      },

      onError: (file, error) => {
        this.debug(`Config file error: ${file} - ${error.message}`);
        this.callbacks.onError?.(file, error);
      },
    };

    this.watcher = createConfigWatcher(this.workspaceRootPath, watcherCallbacks);
    this.debug('Config watcher started');
  }

  /**
   * 停止监听配置文件。
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
      this.debug('Config watcher stopped');
    }
  }

  /**
   * 判断监听器是否正在运行。
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }

  /**
   * 构造完成后更新回调集合（合并式覆盖）。
   * 适用场景：回调里需要引用 agent 状态，但构造 watcher 时这些状态还未就绪。
   *
   * 注意：`Partial<T>` 表示 T 的所有字段都变成可选；`{ ...a, ...b }` 是对象展开合并，
   * b 中存在的字段会覆盖 a 的同名字段。
   */
  updateCallbacks(callbacks: Partial<ConfigWatcherManagerCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * 获取当前正在监听的 workspace 根路径。
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  /**
   * 内部调试日志：同时走用户传入的 onDebug 回调和全局 debug 通道。
   */
  private debug(message: string): void {
    const formattedMessage = `[ConfigWatcherManager] ${message}`;
    if (this.onDebugCallback) {
      this.onDebugCallback(formattedMessage);
    }
    debug(formattedMessage);
  }
}

/**
 * 工厂函数：创建一个 ConfigWatcherManager，并按需立即启动。
 *
 * @param config - 管理器配置
 * @param callbacks - 配置变更回调
 * @param autoStart - 是否在创建后立即启动监听（默认 true）
 * @returns 已配置好的 ConfigWatcherManager 实例
 */
export function createConfigWatcherManager(
  config: ConfigWatcherManagerConfig,
  callbacks: ConfigWatcherManagerCallbacks = {},
  autoStart = true
): ConfigWatcherManager {
  const manager = new ConfigWatcherManager(config, callbacks);
  if (autoStart) {
    manager.start();
  }
  return manager;
}
