/**
 * 图标常量
 *
 * 纯常量与纯函数，用于图标处理。
 * 不依赖 Node.js，可被浏览器 / renderer 安全导入。
 *
 * 这些函数从 icon.ts 中拆分出来，避免 renderer 代码 import 时拖入 fs/path 依赖。
 */

// ============================================================
// 常量
// ============================================================

/**
 * 综合 emoji 检测正则。
 * 可匹配单个 emoji、emoji 序列以及多码位 emoji（例如 👨‍💻）。
 */
export const EMOJI_REGEX = /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*$/u;

/**
 * 支持的图标文件扩展名，按优先级排序。
 */
export const ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.ico', '.webp', '.gif'];

// ============================================================
// 纯函数（无 Node.js 依赖）
// ============================================================

/**
 * 判断字符串是否为 emoji（单个或多码位）。
 * 示例："🔧"、"👨‍💻"、"🎉"
 *
 * @param str - 待检测字符串
 * @returns 是 emoji 返回 true，否则 false
 */
export function isEmoji(str: string | undefined): boolean {
  if (!str || str.length === 0) return false;
  // Emoji 通常很短——即使有修饰符也很少超过 20 个字符
  if (str.length > 20) return false;
  return EMOJI_REGEX.test(str);
}

/**
 * 判断字符串是否为合法的图标 URL（http 或 https）。
 */
export function isIconUrl(str: string): boolean {
  return str.startsWith('http://') || str.startsWith('https://');
}

/**
 * 判断图标值是否非法（内联 SVG 或相对路径）。
 * 为了保持配置干净，这些格式被明确拒绝。
 */
export function isInvalidIconValue(str: string): boolean {
  // 内联 SVG 以 < 开头（如 "<svg..."）
  if (str.startsWith('<')) return true;
  // 相对路径以 . 或 / 开头
  if (str.startsWith('.') || str.startsWith('/')) return true;
  return false;
}
