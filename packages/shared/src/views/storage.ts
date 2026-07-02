/**
 * Views Storage
 *
 * workspace 视图配置的文件系统存储。
 * 视图保存在 {workspaceRootPath}/views.json。
 *
 * 视图是基于表达式的动态筛选器，运行时从 session 状态计算得出，
 * 不会被持久化到 session 本身。
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ViewConfig } from './types.ts';
import { getDefaultViews } from './defaults.ts';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';

/** 视图配置文件的固定文件名 */
const VIEWS_FILE = 'views.json';

/**
 * 视图配置文件的整体结构。
 */
export interface ViewsConfig {
  /** 配置格式版本号 */
  version: number;
  /** 视图定义数组 */
  views: ViewConfig[];
}

/**
 * 从 workspace 加载视图配置。
 * 如果文件不存在或解析失败，返回默认视图。
 * 还负责从旧的 labels/config.json 里的 smartLabels 迁移数据。
 */
export function loadViewsConfig(workspaceRootPath: string): ViewsConfig {
  const configPath = join(workspaceRootPath, VIEWS_FILE);

  // 如果没有 views.json，先检查老版本 labels/config.json 里的 smartLabels 并迁移；
  // 否则用默认视图初始化一份。
  if (!existsSync(configPath)) {
    const migrated = migrateFromSmartLabels(workspaceRootPath);
    if (migrated) {
      debug('[loadViewsConfig] Migrated from legacy smartLabels');
      return migrated;
    }

    // 没有旧数据 —— 用默认视图生成初始配置
    const defaults: ViewsConfig = { version: 1, views: getDefaultViews() };
    debug('[loadViewsConfig] No config found, seeding with default views');
    saveViewsConfig(workspaceRootPath, defaults);
    return defaults;
  }

  try {
    const config = readJsonFileSync<ViewsConfig>(configPath);
    return config;
  } catch (error) {
    debug('[loadViewsConfig] Failed to parse config:', error);
    return { version: 1, views: getDefaultViews() };
  }
}

/**
 * 把视图配置保存到磁盘。
 */
export function saveViewsConfig(
  workspaceRootPath: string,
  config: ViewsConfig
): void {
  const configPath = join(workspaceRootPath, VIEWS_FILE);

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveViewsConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * 列出某个 workspace 下的所有视图。
 * 如果配置不存在，会先以默认视图初始化，再返回 views 数组。
 */
export function listViews(workspaceRootPath: string): ViewConfig[] {
  const config = loadViewsConfig(workspaceRootPath);
  // `config.views ?? []`：如果 views 是 null/undefined，返回空数组
  return config.views ?? [];
}

/**
 * 保存视图列表到 workspace 配置。
 * 会替换整个 views 数组。
 */
export function saveViews(
  workspaceRootPath: string,
  views: ViewConfig[]
): void {
  const config = loadViewsConfig(workspaceRootPath);
  config.views = views;
  saveViewsConfig(workspaceRootPath, config);
}

/**
 * 从旧版 labels/config.json 的 smartLabels 迁移到 views.json。
 * 把 ID 前缀从 "smart-*" 重命名为 "view-*"。
 * 如果发生迁移则返回迁移后的配置，否则返回 null。
 */
function migrateFromSmartLabels(workspaceRootPath: string): ViewsConfig | null {
  const labelsConfigPath = join(workspaceRootPath, 'labels', 'config.json');
  if (!existsSync(labelsConfigPath)) return null;

  try {
    const labelsConfig = readJsonFileSync<Record<string, any>>(labelsConfigPath);
    if (!labelsConfig.smartLabels || !Array.isArray(labelsConfig.smartLabels)) return null;

    // 迁移：ID 从 smart-* 改为 view-*
    const views: ViewConfig[] = labelsConfig.smartLabels.map((sl: any) => ({
      ...sl,
      id: sl.id?.startsWith('smart-') ? sl.id.replace('smart-', 'view-') : sl.id,
    }));

    const config: ViewsConfig = { version: 1, views };
    saveViewsConfig(workspaceRootPath, config);

    // 从 labels 配置里删掉 smartLabels，避免两边同时存在造成混淆
    delete labelsConfig.smartLabels;
    writeFileSync(labelsConfigPath, JSON.stringify(labelsConfig, null, 2), 'utf-8');

    return config;
  } catch {
    return null;
  }
}
