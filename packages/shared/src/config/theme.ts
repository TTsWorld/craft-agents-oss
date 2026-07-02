/**
 * 主题配置。
 *
 * 应用级主题系统，内置多套预设主题，默认浅色模式，可单独覆盖深色模式。
 * 存储位置：
 * - 应用覆盖：~/.craft-agent/theme.json
 * - 预设主题：~/.craft-agent/themes/*.json
 */

/**
 * CSS 颜色字符串，支持任意合法 CSS 颜色格式：
 * - 十六进制：#8b5cf6, #8b5cf6cc
 * - RGB：rgb(139, 92, 246), rgba(139, 92, 246, 0.8)
 * - HSL：hsl(262, 83%, 58%)
 * - OKLCH：oklch(0.58 0.22 293)（推荐）
 * - 命名颜色：purple, rebeccapurple
 */
export type CSSColor = string;

/**
 * 核心主题色（6 色语义系统）
 */
export interface ThemeColors {
  background?: CSSColor;
  foreground?: CSSColor;
  accent?: CSSColor; // 品牌紫（Execute 模式）
  info?: CSSColor; // 琥珀色（Ask 模式、警告）
  success?: CSSColor; // 绿色
  destructive?: CSSColor; // 红色
}

/**
 * 特定 UI 区域使用的表面色。
 * 全部可选，未设置时回退到 background。
 */
export interface SurfaceColors {
  paper?: CSSColor; // AI 消息、卡片、抬高内容
  navigator?: CSSColor; // 左侧边栏背景
  input?: CSSColor; // 输入框背景
  popover?: CSSColor; // 下拉框、弹窗、右键菜单（始终纯色，无透明度）
  popoverSolid?: CSSColor; // 保证 100% 不透明的 popover 背景（scenic 模式必需）
}

/** 主题模式：solid（默认）或 scenic（背景图+玻璃面板） */
export type ThemeMode = 'solid' | 'scenic';

/**
 * 主题覆盖：默认浅色，可选深色覆盖。
 * 仅应用级，不涉及 workspace 级联。
 */
export interface ThemeOverrides extends ThemeColors, SurfaceColors {
  // 可选的深色模式覆盖（包含语义色和表面色）
  dark?: ThemeColors & SurfaceColors;

  /**
   * 主题模式：'solid'（默认）或 'scenic'
   * - solid：传统纯色背景
   * - scenic：全窗口背景图 + 玻璃面板
   */
  mode?: ThemeMode;

  /**
   * scenic 模式的背景图 URL。
   *  mode='scenic' 时必填，其他模式忽略。
   */
  backgroundImage?: string;
}

/**
 * 深度合并两个主题对象（source 中已定义的值优先）。
 */
const COLOR_KEYS: (keyof ThemeColors)[] = [
  'background',
  'foreground',
  'accent',
  'info',
  'success',
  'destructive',
];

const SURFACE_KEYS: (keyof SurfaceColors)[] = [
  'paper',
  'navigator',
  'input',
  'popover',
  'popoverSolid',
];

// 合并时使用的全部颜色 key（语义色 + 表面色）
const ALL_COLOR_KEYS = [...COLOR_KEYS, ...SURFACE_KEYS] as const;

function mergeThemes(
  base: ThemeOverrides | undefined,
  override: ThemeOverrides | undefined
): ThemeOverrides {
  if (!base) return override || {};
  if (!override) return base;

  const result: ThemeOverrides = { ...base };

  // 合并顶层颜色属性（语义色 + 表面色）
  for (const key of ALL_COLOR_KEYS) {
    if (override[key] !== undefined) {
      result[key] = override[key];
    }
  }

  // 合并 scenic 模式属性
  if (override.mode !== undefined) result.mode = override.mode;
  if (override.backgroundImage !== undefined)
    result.backgroundImage = override.backgroundImage;

  // 深度合并深色覆盖
  if (override.dark) {
    result.dark = { ...base.dark };
    for (const key of ALL_COLOR_KEYS) {
      if (override.dark[key] !== undefined) {
        result.dark![key] = override.dark[key];
      }
    }
  }

  return result;
}

/**
 * 从应用级主题源解析出最终主题。
 * （workspace 级联已移除，简化逻辑。）
 */
export function resolveTheme(
  app?: ThemeOverrides
): ThemeOverrides {
  return mergeThemes(undefined, app) || {};
}

/**
 * 把十六进制颜色转成 RGB 数值字符串，例如 "255, 128, 0"。
 * 可通过 darkenFactor（0-1）按系数压暗颜色，0.7 表示 70% 亮度。
 * 不是合法十六进制时返回 null。
 */
function hexToRgbValues(hex: string, darkenFactor: number = 1): string | null {
  let r: number, g: number, b: number;

  // 匹配 6 位十六进制
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (match) {
    r = parseInt(match[1]!, 16);
    g = parseInt(match[2]!, 16);
    b = parseInt(match[3]!, 16);
  } else {
    // 尝试 3 位十六进制
    const shortMatch = hex.match(/^#?([a-f\d])([a-f\d])([a-f\d])$/i);
    if (!shortMatch) return null;
    r = parseInt(shortMatch[1]! + shortMatch[1]!, 16);
    g = parseInt(shortMatch[2]! + shortMatch[2]!, 16);
    b = parseInt(shortMatch[3]! + shortMatch[3]!, 16);
  }

  // 应用压暗系数
  r = Math.round(r * darkenFactor);
  g = Math.round(g * darkenFactor);
  b = Math.round(b * darkenFactor);

  return `${r}, ${g}, ${b}`;
}

/**
 * 从主题生成 CSS 变量声明。
 * @param theme - 已解析的主题对象
 * @param isDark - 是否应用深色模式覆盖
 * @returns 包含 CSS 变量声明的字符串
 */
export function themeToCSS(theme: ThemeOverrides, isDark: boolean = false): string {
  const vars: string[] = [];

  // 生效颜色：深色模式下合并 dark 覆盖
  const colors: ThemeColors & SurfaceColors =
    isDark && theme.dark ? { ...theme, ...theme.dark } : theme;

  // 语义色变量
  if (colors.background) vars.push(`--background: ${colors.background};`);
  if (colors.foreground) {
    vars.push(`--foreground: ${colors.foreground};`);
    // 同时输出 RGB 版本，用于阴影边框（仅对十六进制颜色有效）
    const rgbValues = hexToRgbValues(colors.foreground);
    if (rgbValues) {
      vars.push(`--foreground-rgb: ${rgbValues};`);
    }
  }
  if (colors.accent) {
    vars.push(`--accent: ${colors.accent};`);
    // 同时输出压暗后的 RGB 版本，用于带色调的阴影（仅对十六进制有效）
    // 使用 70% 亮度获得合适的阴影效果
    const rgbValues = hexToRgbValues(colors.accent, 0.7);
    if (rgbValues) {
      vars.push(`--accent-rgb: ${rgbValues};`);
    }
  }
  if (colors.info) vars.push(`--info: ${colors.info};`);
  if (colors.success) vars.push(`--success: ${colors.success};`);
  if (colors.destructive) vars.push(`--destructive: ${colors.destructive};`);

  // 表面色变量（未设置时回退到 background）
  // 用于精细控制特定 UI 区域
  const bg = colors.background || 'var(--background)';
  vars.push(`--paper: ${colors.paper || bg};`);
  vars.push(`--navigator: ${colors.navigator || bg};`);
  vars.push(`--input: ${colors.input || bg};`);
  vars.push(`--popover: ${colors.popover || bg};`);
  // popoverSolid：scenic 模式下要求 100% 不透明
  // 依次回退到 popoverSolid、popover、background（scenic 主题应保证其为纯色）
  vars.push(`--popover-solid: ${colors.popoverSolid || colors.popover || bg};`);

  // 主题模式（backgroundImage 直接设置在 document.documentElement.style 上，
  // 避免大数据 URL 导致样式表体积过大）
  const mode = theme.mode || 'solid';
  vars.push(`--theme-mode: ${mode};`);

  return vars.join('\n  ');
}

/**
 * 给 Electron BrowserWindow 用的背景色十六进制值。
 * 主进程无法使用 CSS/oklch 颜色，所以提供与 DEFAULT_THEME oklch 颜色视觉匹配的 hex 值。
 */
export const BACKGROUND_HEX = {
  light: '#faf9fb', // 匹配 oklch(0.98 0.003 265)
  dark: '#302f33', // 匹配 oklch(0.2 0.005 270)
} as const;

/**
 * 获取 BrowserWindow backgroundColor 用的背景色 hex 值。
 * 在主进程等没有 CSS 变量的地方使用。
 */
export function getBackgroundColor(isDark: boolean): string {
  return isDark ? BACKGROUND_HEX.dark : BACKGROUND_HEX.light;
}

/**
 * 默认主题值（与当前 index.css 保持一致）
 */
export const DEFAULT_THEME: ThemeOverrides = {
  background: 'oklch(0.98 0.003 265)',
  foreground: 'oklch(0.185 0.01 270)',
  accent: 'oklch(0.58 0.22 293)',
  info: 'oklch(0.75 0.16 70)',
  success: 'oklch(0.55 0.17 145)',
  destructive: 'oklch(0.58 0.24 28)',
  dark: {
    background: 'oklch(0.145 0.015 270)',
    foreground: 'oklch(0.95 0.01 270)',
    accent: 'oklch(0.65 0.22 293)',
    info: 'oklch(0.78 0.14 70)',
    success: 'oklch(0.60 0.17 145)',
    destructive: 'oklch(0.65 0.22 28)',
  },
};

// ============================================
// 预设主题
// ============================================

/**
 * Shiki 语法高亮主题配置
 */
export interface ShikiThemeConfig {
  light?: string;
  dark?: string;
}

/**
 * 扩展主题文件格式（带元数据）。
 * 用于存储为 JSON 文件的预设主题。
 */
export interface ThemeFile extends ThemeOverrides {
  name?: string;
  description?: string;
  author?: string;
  license?: string;
  source?: string;
  supportedModes?: ('light' | 'dark')[];
  shikiTheme?: ShikiThemeConfig;
}

/**
 * 预设主题条目：包含 ID、路径和解析后的主题数据。
 */
export interface PresetTheme {
  id: string; // 不含 .json 的文件名，如 'dracula'
  path: string; // theme.json 的完整路径
  theme: ThemeFile; // 解析后的主题数据
}

/**
 * 默认 Shiki 主题（未选择预设时使用）
 */
export const DEFAULT_SHIKI_THEME: ShikiThemeConfig = {
  light: 'github-light',
  dark: 'github-dark',
};

/**
 * 根据当前模式获取 Shiki 主题名。
 */
export function getShikiTheme(
  shikiConfig: ShikiThemeConfig | undefined,
  isDark: boolean
): string {
  const config = shikiConfig || DEFAULT_SHIKI_THEME;
  return isDark ? config.dark || 'github-dark' : config.light || 'github-light';
}
