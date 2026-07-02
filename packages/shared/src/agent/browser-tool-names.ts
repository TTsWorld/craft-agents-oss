/**
 * Browser 工具命名辅助函数
 *
 * 规范的运行时工具名是 `browser_tool`；但为了兼容旧 session / 测试 / 日志中
 * 出现过的拆分式工具名（browser_open、browser_snapshot 等），这里保留一份别名表。
 *
 * 类比：类似 Go 中处理 deprecated RPC method 名，统一映射到新的 canonical 名。
 */

/**
 * 旧版拆分式 browser 工具别名集合，全部映射到规范的 `browser_tool`。
 * Set<string> 类似 Go 的 map[string]struct{}，用于 O(1) 包含判断。
 */
export const LEGACY_BROWSER_TOOL_ALIASES = new Set<string>([
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_click_at',
  'browser_fill',
  'browser_select',
  'browser_screenshot',
  'browser_screenshot_region',
  'browser_console',
  'browser_window_resize',
  'browser_network',
  'browser_wait',
  'browser_key',
  'browser_downloads',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_evaluate',
]);

/**
 * 去掉工具名的 session 命名空间前缀（mcp__session__ / session__）。
 * 正则中 ^ 匹配开头，(?:...) 为非捕获分组。
 */
function stripSessionPrefix(toolName: string): string {
  return toolName.replace(/^(mcp__session__|session__)/, '');
}

/**
 * 仅把“规范名 `browser_tool`”（可带命名空间前缀）归一化；
 * 不接受任何旧别名。
 *
 * 返回值使用字面量类型 `'browser_tool'` 而非宽泛的 string，
 * 便于调用方做窄化判断。
 */
export function normalizeCanonicalBrowserToolName(toolName: string): 'browser_tool' | null {
  const normalized = toolName.trim();
  if (!normalized) return null;

  // 接受直接形式与带命名空间前缀的形式，例如：
  // - browser_tool
  // - mcp__session__browser_tool
  // - mcp__workspace__browser_tool
  // 正则尾部的 i 标志表示大小写不敏感
  return /(?:^|__)browser_tool$/i.test(normalized) ? 'browser_tool' : null;
}

/**
 * 把 browser 工具名（规范名 + 旧别名）统一归一化为 `browser_tool`。
 */
export function normalizeBrowserToolName(toolName: string): 'browser_tool' | null {
  const canonical = normalizeCanonicalBrowserToolName(toolName);
  if (canonical) return canonical;

  const normalized = toolName.trim();
  if (!normalized) return null;

  const stripped = stripSessionPrefix(normalized);
  return LEGACY_BROWSER_TOOL_ALIASES.has(stripped) ? 'browser_tool' : null;
}

/**
 * 判断工具名是否是“规范名 browser_tool”（可带命名空间前缀）。
 * 即严格不含旧别名。
 */
export function isCanonicalBrowserToolName(toolName: string): boolean {
  return normalizeCanonicalBrowserToolName(toolName) === 'browser_tool';
}

/**
 * 判断工具名是否是 browser 工具（规范名 + 支持的旧别名）。
 */
export function isBrowserToolNameOrAlias(toolName: string): boolean {
  return normalizeBrowserToolName(toolName) === 'browser_tool';
}
