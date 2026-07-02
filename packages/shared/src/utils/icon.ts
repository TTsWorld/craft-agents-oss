/**
 * 统一图标处理工具
 *
 * 为 skill、source 和 status 提供共享的图标处理能力。
 * 这三套系统使用相同的图标格式与行为：
 *
 * 支持格式：
 * - Emoji："🔧" - 在 UI 中作为文本渲染
 * - URL："https://..." - 自动下载为 icon.{ext} 文件
 * - 文件：icon.svg、icon.png 等 - 在目录中自动发现
 *
 * 优先级：配置值（emoji/URL）> 本地文件（自动发现）
 * 配置是单一事实来源。仅当 config.icon 为 undefined 时才使用本地文件。
 *
 * 不支持（会被拒绝）：
 * - 内联 SVG："<svg>...</svg>"
 * - 相对路径："./icon.svg"、"/path/to/icon"
 */

import { existsSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { debug } from './debug.ts';

// 从 icon-constants.ts 重新导出纯常量，保持向后兼容。
// Renderer 代码应直接从 icon-constants.ts 导入，避免引入 Node.js 依赖。
export {
  EMOJI_REGEX,
  ICON_EXTENSIONS,
  isEmoji,
  isIconUrl,
  isInvalidIconValue,
} from './icon-constants.ts';

import { ICON_EXTENSIONS, isEmoji, isIconUrl, isInvalidIconValue } from './icon-constants.ts';

/**
 * Content-Type 到文件扩展名的映射，用于图标下载。
 */
const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// ============================================================
// 校验函数
// ============================================================

/**
 * 校验并归一化图标值。
 * 合法时返回原值（emoji 或 URL），非法时返回 undefined。
 *
 * @param icon - 待校验的图标值
 * @param context - debug 日志上下文（如 "Skills"、"Sources"、"Statuses"）
 */
export function validateIconValue(icon: unknown, context: string = 'Icon'): string | undefined {
  if (typeof icon !== 'string' || !icon.trim()) {
    return undefined;
  }

  const trimmed = icon.trim();

  // 拒绝非法值（内联 SVG、相对路径）
  if (isInvalidIconValue(trimmed)) {
    debug(`[${context}] Invalid icon value (inline SVG or relative path not supported):`, trimmed.slice(0, 50));
    return undefined;
  }

  // 接受 emoji 或 URL
  if (isEmoji(trimmed) || isIconUrl(trimmed)) {
    return trimmed;
  }

  // 未知格式 - 拒绝
  debug(`[${context}] Unknown icon format, must be emoji or URL:`, trimmed);
  return undefined;
}

// ============================================================
// 文件发现
// ============================================================

/**
 * 在目录中查找图标文件。
 * 返回第一个匹配的 icon.{svg,png,jpg,jpeg}，未找到返回 undefined。
 *
 * @param dir - 要搜索的目录
 */
export function findIconFile(dir: string): string | undefined {
  for (const ext of ICON_EXTENSIONS) {
    const iconPath = join(dir, `icon${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }
  return undefined;
}

// ============================================================
// 下载函数
// ============================================================

/**
 * 从 URL 路径中提取文件扩展名。
 * 返回带点号的扩展名（如 ".svg"），找不到返回 null。
 */
function getExtensionFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    if (ICON_EXTENSIONS.includes(ext) || ext === '.jpeg') {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch {
    // URL 不合法
  }
  return null;
}

/**
 * 从 URL 下载图标并保存到目录。
 * 返回下载后的图标路径，失败返回 null。
 *
 * @param targetDir - 保存图标的目录
 * @param iconUrl - 图标 URL
 * @param context - debug 日志上下文
 * @param filenameBase - 自定义文件名基础（默认 'icon'），保存为 {filenameBase}.{ext}
 */
export async function downloadIcon(
  targetDir: string,
  iconUrl: string,
  context: string = 'Icon',
  filenameBase: string = 'icon'
): Promise<string | null> {
  debug(`[${context}] Downloading icon from:`, iconUrl);

  try {
    const response = await fetch(iconUrl, {
      headers: {
        'User-Agent': 'Craft-Agent/1.0',
      },
    });

    if (!response.ok) {
      debug(`[${context}] Icon download failed:`, response.status, response.statusText);
      return null;
    }

    // 根据 content-type 或 URL 确定扩展名
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    let ext = contentType ? CONTENT_TYPE_TO_EXT[contentType] : null;

    // content-type 不匹配时回退到 URL 扩展名
    if (!ext) {
      ext = getExtensionFromUrl(iconUrl);
    }

    // 无法确定类型时默认 .svg
    if (!ext) {
      debug(`[${context}] Could not determine icon type, defaulting to .svg`);
      ext = '.svg';
    }

    // 读取响应体并写入文件
    const buffer = await response.arrayBuffer();
    const iconPath = join(targetDir, `${filenameBase}${ext}`);
    writeFileSync(iconPath, Buffer.from(buffer));

    debug(`[${context}] Icon downloaded successfully:`, iconPath);
    return iconPath;
  } catch (error) {
    debug(`[${context}] Icon download error:`, error);
    return null;
  }
}

/**
 * 检查图标是否需要下载。
 * 当图标是 URL 且本地图标文件不存在时返回 true。
 */
export function needsIconDownload(iconValue: string | undefined, localIconPath: string | undefined): boolean {
  // 没有指定图标 URL
  if (!iconValue || !isIconUrl(iconValue)) {
    return false;
  }
  // 本地图标文件已存在
  if (localIconPath) {
    return false;
  }
  return true;
}

// ============================================================
// 图标解析
// ============================================================

/**
 * 图标解析结果。
 * type 表示图标类型：file（本地文件）、emoji、url（远程）、none（无）。
 */
export interface ResolvedIcon {
  type: 'file' | 'emoji' | 'url' | 'none';
  /** file：绝对路径；emoji：emoji 字符串；url：URL */
  value?: string;
}

/**
 * 解析图标用于渲染。
 * 配置值是单一事实来源，本地文件仅作为自动发现的回退。
 *
 * 优先级：
 * 1. 配置中的 emoji → emoji
 * 2. 配置中的 URL → url（调用方负责下载/展示）
 * 3. 本地文件（自动发现）→ file
 * 4. 无
 *
 * @param iconValue - 配置中的图标值（emoji 或 URL）
 * @param localIconPath - 本地图标文件路径（如果存在，自动发现得到）
 */
export function resolveIcon(iconValue: string | undefined, localIconPath: string | undefined): ResolvedIcon {
  // 优先级 1：配置中的 emoji
  if (iconValue && isEmoji(iconValue)) {
    return { type: 'emoji', value: iconValue };
  }

  // 优先级 2：配置中的 URL（调用方负责下载/展示）
  if (iconValue && isIconUrl(iconValue)) {
    return { type: 'url', value: iconValue };
  }

  // 优先级 3：自动发现的本地文件（仅当 config.icon 为 undefined 时）
  if (localIconPath) {
    return { type: 'file', value: localIconPath };
  }

  // 无图标
  return { type: 'none' };
}
