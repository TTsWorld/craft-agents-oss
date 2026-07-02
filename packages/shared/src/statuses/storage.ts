/**
 * 状态存储层
 *
 * 基于文件系统保存 workspace 的状态配置。
 * 配置文件路径：{workspaceRootPath}/statuses/config.json
 *
 * 图标处理：
 * - 本地文件：statuses/icons/{id}.svg（自动发现）
 * - Emoji：在 UI 中作为文本渲染
 * - URL：自动下载到 statuses/icons/{id}.{ext}
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WorkspaceStatusConfig, StatusConfig, StatusCategory } from './types.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { DEFAULT_ICON_SVGS } from './default-icons.ts';
import {
  validateIconValue,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
  ICON_EXTENSIONS,
} from '../utils/icon.ts';
import { migrateStatusColors } from '../colors/migrate.ts';
import { debug } from '../utils/debug.ts';

// 状态配置所在的目录名和文件名
const STATUS_CONFIG_DIR = 'statuses';
const STATUS_CONFIG_FILE = 'statuses/config.json';
// 状态图标存放目录
const STATUS_ICONS_DIR = 'statuses/icons';

/**
 * 获取默认状态配置（与当前硬编码行为保持一致）
 *
 * 注意：这里没有写 icon 字段，实际会从 statuses/icons/{id}.svg 自动发现图标。
 */
export function getDefaultStatusConfig(): WorkspaceStatusConfig {
  // 注意：color 也被省略，最终由 colors/defaults.ts 应用默认值：
  // - backlog: foreground/50（不显眼，表示尚未计划）
  // - todo: foreground/50（不显眼，表示准备开始）
  // - needs-review: info（琥珀色，表示需要关注）
  // - done: accent（紫色，表示已完成）
  // - cancelled: foreground/50（不显眼，表示已取消）
  //
  // 注意：icon 被省略，实际会从 statuses/icons/{id}.svg 自动发现
  return {
    version: 1,
    statuses: [
      {
        id: 'backlog',
        label: 'Backlog',
        category: 'open',
        isFixed: false,
        isDefault: true,
        order: 0,
      },
      {
        id: 'todo',
        label: 'Todo',
        category: 'open',
        isFixed: true,
        isDefault: false,
        order: 1,
      },
      {
        id: 'needs-review',
        label: 'Needs Review',
        category: 'open',
        isFixed: false,
        isDefault: true,
        order: 2,
      },
      {
        id: 'done',
        label: 'Done',
        category: 'closed',
        isFixed: true,
        isDefault: false,
        order: 3,
      },
      {
        id: 'cancelled',
        label: 'Cancelled',
        category: 'closed',
        isFixed: true,
        isDefault: false,
        order: 4,
      },
    ],
    defaultStatusId: 'todo',
  };
}

/**
 * 确保 statuses/icons/ 目录下存在默认图标文件
 * 如果缺失，就使用内置的 SVG 字符串创建文件
 */
export function ensureDefaultIconFiles(workspaceRootPath: string): void {
  const iconsDir = join(workspaceRootPath, STATUS_ICONS_DIR);

  // 如果图标目录不存在则创建（recursive: true 表示递归创建父目录）
  if (!existsSync(iconsDir)) {
    mkdirSync(iconsDir, { recursive: true });
  }

  // 遍历所有默认图标，缺失时写入文件
  for (const [statusId, svgContent] of Object.entries(DEFAULT_ICON_SVGS)) {
    const iconPath = join(iconsDir, `${statusId}.svg`);

    if (!existsSync(iconPath)) {
      try {
        writeFileSync(iconPath, svgContent, 'utf-8');
      } catch (error) {
        console.error(`[ensureDefaultIconFiles] Failed to write ${statusId}.svg:`, error);
      }
    }
  }
}

/**
 * 校验状态配置是否包含必需的固定状态
 * @returns 如果 todo、done、cancelled 都是 fixed 状态则返回 true
 */
function validateStatusConfig(config: WorkspaceStatusConfig): boolean {
  const requiredFixedStatuses = ['todo', 'done', 'cancelled'];

  return requiredFixedStatuses.every(id =>
    config.statuses.some(s => s.id === id && s.isFixed)
  );
}

/**
 * 加载 workspace 的状态配置
 *
 * 如果配置文件不存在或校验失败，返回默认配置。
 * 同时会确保默认图标文件存在。
 * 首次加载时，还会把旧的 Tailwind 颜色格式自动迁移为 EntityColor。
 */
export function loadStatusConfig(workspaceRootPath: string): WorkspaceStatusConfig {
  // 先确保默认图标文件存在（自我修复）
  ensureDefaultIconFiles(workspaceRootPath);

  const configPath = join(workspaceRootPath, STATUS_CONFIG_FILE);

  // 配置文件不存在时直接返回默认配置
  if (!existsSync(configPath)) {
    return getDefaultStatusConfig();
  }

  try {
    // readJsonFileSync<T> 是泛型函数调用，<T> 告诉 TS 期望的返回类型。
    const config = readJsonFileSync<WorkspaceStatusConfig>(configPath);

    // 校验必需的固定状态是否存在
    if (!validateStatusConfig(config)) {
      console.warn('[loadStatusConfig] Invalid config: missing required fixed statuses, returning defaults');
      return getDefaultStatusConfig();
    }

    // 自动把旧的 Tailwind 类名颜色（如 "text-accent"）迁移为新的 EntityColor 格式。
    // 如果发生了迁移，就把更新后的配置写回磁盘。
    const migrated = migrateStatusColors(config);
    if (migrated) {
      debug('[loadStatusConfig] Migrated old color format, writing back');
      saveStatusConfig(workspaceRootPath, config);
    }

    return config;
  } catch (error) {
    console.error('[loadStatusConfig] Failed to parse config:', error);
    return getDefaultStatusConfig();
  }
}

/**
 * 把 workspace 状态配置保存到磁盘
 */
export function saveStatusConfig(
  workspaceRootPath: string,
  config: WorkspaceStatusConfig
): void {
  const statusDir = join(workspaceRootPath, STATUS_CONFIG_DIR);
  const configPath = join(workspaceRootPath, STATUS_CONFIG_FILE);

  // 目录不存在时创建
  if (!existsSync(statusDir)) {
    mkdirSync(statusDir, { recursive: true });
  }

  // 以 JSON 格式写入磁盘，缩进 2 个空格便于阅读
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    console.error('[saveStatusConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * 根据 ID 获取单个状态
 * @returns 状态配置；找不到时返回 null
 */
export function getStatus(
  workspaceRootPath: string,
  statusId: string
): StatusConfig | null {
  const config = loadStatusConfig(workspaceRootPath);
  return config.statuses.find(s => s.id === statusId) || null;
}

/**
 * 获取所有状态，并按 order 字段排序
 */
export function listStatuses(workspaceRootPath: string): StatusConfig[] {
  const config = loadStatusConfig(workspaceRootPath);
  return [...config.statuses].sort((a, b) => a.order - b.order);
}

/**
 * 判断某个状态 ID 在当前 workspace 中是否有效
 */
export function isValidStatusId(
  workspaceRootPath: string,
  statusId: string
): boolean {
  const config = loadStatusConfig(workspaceRootPath);
  return config.statuses.some(s => s.id === statusId);
}

/**
 * 获取某个状态 ID 对应的分类
 * @returns 分类字符串；找不到时返回 null
 */
export function getStatusCategory(
  workspaceRootPath: string,
  statusId: string
): StatusCategory | null {
  const status = getStatus(workspaceRootPath, statusId);
  // ?. 是可选链：如果 status 为 null/undefined，就不会访问 .category，直接返回 undefined。
  return status?.category || null;
}

// ============================================================
// 图标相关操作（复用 utils/icon.ts 里的工具函数）
// ============================================================

/**
 * 查找某个状态的图标文件
 *
 * 会依次查找 statuses/icons/{statusId}.{svg,png,jpg,jpeg}，
 * 返回找到的第一个文件的绝对路径，找不到则返回 undefined。
 */
export function findStatusIcon(
  workspaceRootPath: string,
  statusId: string
): string | undefined {
  const iconsDir = join(workspaceRootPath, STATUS_ICONS_DIR);

  for (const ext of ICON_EXTENSIONS) {
    const iconPath = join(iconsDir, `${statusId}${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }
  return undefined;
}

/**
 * 从 URL 下载图标并保存到状态图标目录
 *
 * 保存路径为 statuses/icons/{statusId}.{ext}。
 * 返回下载后的文件路径，失败时返回 null。
 */
export async function downloadStatusIcon(
  workspaceRootPath: string,
  statusId: string,
  iconUrl: string
): Promise<string | null> {
  const iconsDir = join(workspaceRootPath, STATUS_ICONS_DIR);

  // 确保图标目录存在
  if (!existsSync(iconsDir)) {
    mkdirSync(iconsDir, { recursive: true });
  }

  // 先下载到临时文件，再重命名为 {statusId}.{ext}
  const tempPath = await downloadIcon(iconsDir, iconUrl, 'Statuses');
  if (!tempPath) return null;

  // 从 icon.{ext} 重命名为 {statusId}.{ext}
  const ext = tempPath.substring(tempPath.lastIndexOf('.'));
  const finalPath = join(iconsDir, `${statusId}${ext}`);

  try {
    const { renameSync, unlinkSync } = await import('fs');
    // 删除扩展名不同的旧图标文件
    for (const existingExt of ICON_EXTENSIONS) {
      const existingPath = join(iconsDir, `${statusId}${existingExt}`);
      if (existsSync(existingPath) && existingPath !== finalPath) {
        unlinkSync(existingPath);
      }
    }
    // 把临时文件重命名为最终路径
    if (tempPath !== finalPath) {
      renameSync(tempPath, finalPath);
    }
    debug(`[downloadStatusIcon] Icon saved for ${statusId}: ${finalPath}`);
    return finalPath;
  } catch (error) {
    debug(`[downloadStatusIcon] Failed to rename icon for ${statusId}:`, error);
    return tempPath; // 失败时返回临时路径兜底
  }
}

/**
 * 判断某个状态的图标是否需要下载
 *
 * 当配置里的 icon 是 URL，且本地还没有对应图标文件时返回 true。
 */
export function statusNeedsIconDownload(
  workspaceRootPath: string,
  status: StatusConfig
): boolean {
  const iconPath = findStatusIcon(workspaceRootPath, status.id);
  return needsIconDownload(status.icon, iconPath);
}

// 为方便上层调用，重新导出 isIconUrl
export { isIconUrl } from '../utils/icon.ts';
