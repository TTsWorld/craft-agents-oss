/**
 * 标签存储
 *
 * 基于文件系统的 workspace 标签配置存储。
 * 标签存储在 {workspaceRootPath}/labels/config.json。
 *
 * 层级：标签是嵌套 JSON 树，ID 为简单 slug。
 * 新 workspace 会用默认标签做种子（Development + Content 两组）。
 * 标签在 UI 中只通过颜色（彩色圆点）呈现。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WorkspaceLabelConfig, LabelConfig } from './types.ts';
import { flattenLabels, findLabelById } from './tree.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { migrateLabelColors } from '../colors/migrate.ts';
import { debug } from '../utils/debug.ts';

const LABEL_CONFIG_DIR = 'labels';
const LABEL_CONFIG_FILE = 'labels/config.json';

/**
 * 获取默认标签配置。
 * 提供一组入门标签，分为两个互补色系：
 * - Development（蓝色系）：Code、Bug、Automation
 * - Content（紫色系）：Writing、Research、Design
 * 再加两个带值标签：Priority（number）、Project（string）
 *
 * 子标签使用父标签色相偏移后的色调，以展示视觉层级。
 */
export function getDefaultLabelConfig(): WorkspaceLabelConfig {
  return {
    version: 1,
    labels: [
      {
        id: 'development',
        name: 'Development',
        color: { light: '#3B82F6', dark: '#60A5FA' },
        children: [
          {
            id: 'code',
            name: 'Code',
            color: { light: '#4F46E5', dark: '#818CF8' }, // 靛蓝偏移
          },
          {
            id: 'bug',
            name: 'Bug',
            color: { light: '#0EA5E9', dark: '#38BDF8' }, // 天蓝偏移
          },
          {
            id: 'automation',
            name: 'Automation',
            color: { light: '#06B6D4', dark: '#22D3EE' }, // 青色偏移
          },
        ],
      },
      {
        id: 'content',
        name: 'Content',
        color: { light: '#8B5CF6', dark: '#A78BFA' },
        children: [
          {
            id: 'writing',
            name: 'Writing',
            color: { light: '#7C3AED', dark: '#C4B5FD' }, // 深紫罗兰
          },
          {
            id: 'research',
            name: 'Research',
            color: { light: '#A855F7', dark: '#C084FC' }, // 浅紫色
          },
          {
            id: 'design',
            name: 'Design',
            color: { light: '#D946EF', dark: '#E879F9' }, // 紫红偏移
          },
        ],
      },
      {
        id: 'priority',
        name: 'Priority',
        color: { light: '#F59E0B', dark: '#FBBF24' },
        valueType: 'number',
      },
      {
        id: 'project',
        name: 'Project',
        color: 'foreground/50',
        valueType: 'string',
      },
    ],
  };
}

/**
 * 加载 workspace 的标签配置。
 * 若文件不存在或解析失败，返回默认配置。
 * 首次加载时自动把旧的 Tailwind 颜色格式迁移为 EntityColor。
 */
export function loadLabelConfig(workspaceRootPath: string): WorkspaceLabelConfig {
  const configPath = join(workspaceRootPath, LABEL_CONFIG_FILE);

  // 如果配置文件不存在，用默认值做种子并落盘。
  // 这样早期创建的 workspace 也能自动获得默认标签。
  if (!existsSync(configPath)) {
    const defaults = getDefaultLabelConfig();
    debug('[loadLabelConfig] No config found, seeding with default labels');
    saveLabelConfig(workspaceRootPath, defaults);
    return defaults;
  }

  try {
    // readJsonFileSync<WorkspaceLabelConfig> 中的 <T> 是 TypeScript 泛型，
    // 类似 Go 的类型参数，告诉函数返回什么类型。
    const config = readJsonFileSync<WorkspaceLabelConfig>(configPath);

    // 自动迁移旧 Tailwind 类名颜色（如 "text-accent"）到新 EntityColor 格式。
    // 如果发生迁移，把更新后的配置写回磁盘。
    const migrated = migrateLabelColors(config);
    if (migrated) {
      debug('[loadLabelConfig] Migrated old color format, writing back');
      saveLabelConfig(workspaceRootPath, config);
    }

    return config;
  } catch (error) {
    debug('[loadLabelConfig] Failed to parse config:', error);
    return getDefaultLabelConfig();
  }
}

/**
 * 保存 workspace 标签配置到磁盘。
 * 如果 labels 目录不存在则自动创建。
 */
export function saveLabelConfig(
  workspaceRootPath: string,
  config: WorkspaceLabelConfig
): void {
  const labelDir = join(workspaceRootPath, LABEL_CONFIG_DIR);
  const configPath = join(workspaceRootPath, LABEL_CONFIG_FILE);

  if (!existsSync(labelDir)) {
    mkdirSync(labelDir, { recursive: true });
  }

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveLabelConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * 获取标签树（含嵌套 children 的顶层标签）。
 * UI 主要使用这个访问器，直接返回配置中的树结构。
 */
export function listLabels(workspaceRootPath: string): LabelConfig[] {
  const config = loadLabelConfig(workspaceRootPath);
  return config.labels;
}

/**
 * 获取所有标签的扁平列表（按深度优先展开树）。
 * 适用于查找、会话标签校验、非层级展示等场景。
 */
export function listLabelsFlat(workspaceRootPath: string): LabelConfig[] {
  const config = loadLabelConfig(workspaceRootPath);
  return flattenLabels(config.labels);
}

/**
 * 根据 ID 获取单个标签（搜索整棵树）。
 * 找不到时返回 null。
 */
export function getLabel(
  workspaceRootPath: string,
  labelId: string
): LabelConfig | null {
  const config = loadLabelConfig(workspaceRootPath);
  return findLabelById(config.labels, labelId) || null;
}

/**
 * 检查某个标签 ID 是否存在于该 workspace 中（搜索整棵树）。
 */
export function isValidLabelId(
  workspaceRootPath: string,
  labelId: string
): boolean {
  const config = loadLabelConfig(workspaceRootPath);
  return !!findLabelById(config.labels, labelId);
}

/**
 * 校验标签 ID 格式。
 * 简单 slug：小写字母、数字和连字符，不能有前导/尾随连字符。
 * 示例："bug"、"frontend"、"my-label"
 */
export function isValidLabelIdFormat(labelId: string): boolean {
  if (!labelId) return false;
  const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  return SLUG_PATTERN.test(labelId);
}
