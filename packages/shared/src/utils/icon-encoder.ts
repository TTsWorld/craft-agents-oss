/**
 * 图标编码工具
 *
 * 将图标文件路径转换为 base64 data URL，便于嵌入会话存储。
 * 这样 session viewer（Web 端）无需访问文件系统也能显示图标。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { extname, dirname, basename, join } from 'path';
import { isEmoji } from './icon-constants.ts';

/**
 * 图标文件扩展名到 MIME 类型的映射。
 */
const EXT_TO_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * 缩略图目标尺寸（像素）。
 * UI 中图标显示为 20x20，32x32 可在 2x 屏下保证清晰度。
 */
const ICON_TARGET_SIZE = 32;

/**
 * 直接编码而不缩放的文件大小上限（50KB）。
 * 未提供 resize 回调时，小于此大小的文件会直接编码。
 */
const MAX_FILE_SIZE = 50 * 1024;

/** 支持缩放的位图扩展名（SVG 是矢量，跳过缩放） */
const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.ico', '.webp', '.gif']);

/**
 * 同步编码选项。
 * `resize` 回调接收 buffer 和目标尺寸，返回 PNG buffer 或 undefined。
 */
export interface EncodeIconOptions {
  /** 将位图图标缩放到 32x32 */
  resize?: (buffer: Buffer, targetSize: number) => Buffer | undefined;
}

/**
 * 异步编码选项，支持异步 resize 回调（例如 sharp）。
 */
export interface EncodeIconOptionsAsync {
  /** 异步将位图图标缩放到 32x32 */
  resize?: (buffer: Buffer, targetSize: number) => Promise<Buffer | undefined>;
}

/**
 * 获取图标文件的缩略图缓存路径。
 * 例如 /path/to/icon.png → /path/to/icon.thumb.png
 */
function getThumbPath(iconPath: string): string {
  const dir = dirname(iconPath);
  const ext = extname(iconPath);
  const name = basename(iconPath, ext);
  return join(dir, `${name}.thumb.png`);
}

/**
 * 检查缓存的缩略图是否仍然有效（存在且比原文件新）。
 */
function isThumbValid(iconPath: string, thumbPath: string): boolean {
  if (!existsSync(thumbPath)) return false;
  try {
    const originalMtime = statSync(iconPath).mtimeMs;
    const thumbMtime = statSync(thumbPath).mtimeMs;
    return thumbMtime >= originalMtime;
  } catch {
    return false;
  }
}

/**
 * 将图标文件编码为 base64 data URL。
 *
 * 当通过 options 提供 `resize` 回调时，位图会被缩放到 32x32，
 * 并在原文件旁边缓存为 `{name}.thumb.png`。SVG 始终直接编码（矢量，与分辨率无关）。
 *
 * @param iconPath - 图标文件的绝对路径
 * @param options - 可选的位图缩放回调
 * @returns Base64 data URL（如 "data:image/png;base64,..."），编码失败返回 undefined
 */
export function encodeIconToDataUrl(iconPath: string | undefined, options?: EncodeIconOptions): string | undefined {
  if (!iconPath) {
    return undefined;
  }

  // 已是 data URL，直接透传
  if (iconPath.startsWith('data:')) {
    return iconPath;
  }

  // Emoji 不是文件路径，跳过
  if (isEmoji(iconPath)) {
    return undefined;
  }

  // 检查文件是否存在
  if (!existsSync(iconPath)) {
    return undefined;
  }

  // 根据扩展名获取 MIME 类型
  const ext = extname(iconPath).toLowerCase();
  const mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    return undefined;
  }

  const isRaster = RASTER_EXTENSIONS.has(ext);

  // 对提供 resize 回调的位图，统一生成 32x32 缩略图
  if (isRaster && options?.resize) {
    const thumbPath = getThumbPath(iconPath);

    // 检查有效缓存
    if (isThumbValid(iconPath, thumbPath)) {
      try {
        const thumbBuffer = readFileSync(thumbPath);
        const base64 = thumbBuffer.toString('base64');
        return `data:image/png;base64,${base64}`;
      } catch {
        // 缓存读取失败，继续重新生成
      }
    }

    // 生成缩略图
    try {
      const buffer = readFileSync(iconPath);
      const resized = options.resize(buffer, ICON_TARGET_SIZE);
      if (resized) {
        // 缓存缩略图供下次使用
        try { writeFileSync(thumbPath, resized); } catch { /* 缓存写入尽力而为 */ }
        const base64 = resized.toString('base64');
        return `data:image/png;base64,${base64}`;
      }
    } catch {
      return undefined;
    }
  }

  // 回退：直接编码（SVG 或未提供 resize 回调的位图）
  try {
    const buffer = readFileSync(iconPath);
    if (buffer.length > MAX_FILE_SIZE) {
      return undefined;
    }
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return undefined;
  }
}

/**
 * encodeIconToDataUrl 的异步变体，支持异步 resize 回调（例如 sharp）。
 * 缩略图缓存逻辑与同步版相同。
 */
export async function encodeIconToDataUrlAsync(iconPath: string | undefined, options?: EncodeIconOptionsAsync): Promise<string | undefined> {
  if (!iconPath) {
    return undefined;
  }

  if (iconPath.startsWith('data:')) {
    return iconPath;
  }

  if (isEmoji(iconPath)) {
    return undefined;
  }

  if (!existsSync(iconPath)) {
    return undefined;
  }

  const ext = extname(iconPath).toLowerCase();
  const mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    return undefined;
  }

  const isRaster = RASTER_EXTENSIONS.has(ext);

  if (isRaster && options?.resize) {
    const thumbPath = getThumbPath(iconPath);

    if (isThumbValid(iconPath, thumbPath)) {
      try {
        const thumbBuffer = readFileSync(thumbPath);
        const base64 = thumbBuffer.toString('base64');
        return `data:image/png;base64,${base64}`;
      } catch {
        // 缓存读取失败，继续重新生成
      }
    }

    try {
      const buffer = readFileSync(iconPath);
      const resized = await options.resize(buffer, ICON_TARGET_SIZE);
      if (resized) {
        try { writeFileSync(thumbPath, resized); } catch { /* 缓存写入尽力而为 */ }
        const base64 = resized.toString('base64');
        return `data:image/png;base64,${base64}`;
      }
    } catch {
      return undefined;
    }
  }

  try {
    const buffer = readFileSync(iconPath);
    if (buffer.length > MAX_FILE_SIZE) {
      return undefined;
    }
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return undefined;
  }
}

/**
 * 如果输入是 emoji 则返回其值，否则返回 undefined。
 * ToolDisplayMeta 可能希望把 emoji 作为图标展示。
 */
export function getEmojiIcon(value: string | undefined): string | undefined {
  if (value && isEmoji(value)) {
    return value;
  }
  return undefined;
}
