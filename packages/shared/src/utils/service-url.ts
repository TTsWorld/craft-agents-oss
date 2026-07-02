/**
 * 服务 URL 推导工具 - 浏览器安全版本（无 Node.js 依赖）
 *
 * 本模块可在 Node.js 和浏览器 / renderer 上下文中安全导入。
 * Source：Agent 可调用的外部能力来源，例如 MCP Server 或 API 配置。
 * 如需解析 logo URL，请使用主进程提供的 IPC 版 getLogoUrl。
 */

/**
 * 根据 source 配置推导服务 URL，用于获取 favicon / logo。
 * 如果是 stdio 来源（没有 URL），则回退到 https://{provider}.com。
 *
 * 这是一个纯函数（pure function），不依赖运行环境，类似 Go 中无状态的工具函数。
 *
 * @param config - source 配置对象，可能包含 mcp/api/provider 字段
 * @returns 推导出的服务 URL；无法推导则返回 null
 */
export function deriveServiceUrl(
  config: {
    mcp?: { url?: string };
    api?: { baseUrl?: string; googleService?: string };
    provider?: string;
  }
): string | null {
  // 优先取 API 的 baseUrl，其次 MCP 的 url；?? 是 TS/JS 的空值合并运算符，仅对 null/undefined 生效
  let url = config.api?.baseUrl ?? config.mcp?.url ?? null;

  // stdio 来源没有 URL 时，用 provider 名拼一个默认域名
  if (!url && config.provider) {
    url = `https://${config.provider}.com`;
  }

  return url;
}
