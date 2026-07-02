/**
 * Source Guides 系统
 *
 * 提供 source guide 的解析工具。Guide 本身现在只通过 craft-agents-docs MCP server 分发。
 *
 * Agent 在创建 source 时，应调用 MCP docs 搜索对应的 setup 指南。
 */

// ============================================================
// 类型定义
// ============================================================

// guide 文件顶部 YAML frontmatter 定义。
// 字段带 `?` 表示可选，类似 Go 结构体里指针或 omitempty 字段。
export interface SourceGuideFrontmatter {
  domains?: string[];
  providers?: string[];
}

// 解析后的 source guide 结构。
export interface ParsedSourceGuide {
  frontmatter: SourceGuideFrontmatter;
  knowledge: string; // 服务知识内容
  setupHints: string; // Setup 指导章节
  raw: string; // 原始内容
}

// ============================================================
// 解析
// ============================================================

/**
 * 从 guide 内容中解析 YAML frontmatter。
 * 预期格式：---\nkey: value\n---
 */
function parseFrontmatter(content: string): { frontmatter: SourceGuideFrontmatter; body: string } {
  // 正则匹配 --- 包裹的 frontmatter 和后面的正文。
  // [\s\S] 表示“任意字符包括换行”，类似 Go 的 (?s) 单行模式。
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    return { frontmatter: {}, body: content };
  }

  // 解构正则捕获组：忽略完整匹配项，取 yamlContent 和 body。
  const [, yamlContent, body] = frontmatterMatch;
  const frontmatter: SourceGuideFrontmatter = {};

  if (!yamlContent || !body) {
    return { frontmatter: {}, body: content };
  }

  // 针对本项目的简单 YAML 解析：只处理 domains / providers 两个列表字段。
  const lines = yamlContent.split('\n');
  // currentKey 限定只能是两个已知字段之一，或为空；TS 用联合类型做约束。
  let currentKey: 'domains' | 'providers' | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === 'domains:') {
      currentKey = 'domains';
      frontmatter.domains = [];
    } else if (trimmed === 'providers:') {
      currentKey = 'providers';
      frontmatter.providers = [];
    } else if (trimmed.startsWith('- ') && currentKey) {
      const value = trimmed.slice(2).trim();
      // 可选链 `?.`：若 currentKey 对应数组存在才 push；不存在则短路跳过。
      frontmatter[currentKey]?.push(value);
    }
  }

  return { frontmatter, body };
}

/**
 * 将 source guide 拆分为 frontmatter、knowledge、setupHints 等组成部分。
 * 以 HTML 注释标记 <!-- SETUP: --> 作为分隔。
 */
export function parseSourceGuide(content: string): ParsedSourceGuide {
  const { frontmatter, body } = parseFrontmatter(content);

  // 按 setup 标记切分正文。
  const setupMarker = '<!-- SETUP:';
  const setupIndex = body.indexOf(setupMarker);

  let knowledge: string;
  let setupHints: string;

  if (setupIndex === -1) {
    // 没有 setup 章节，全部内容都作为知识部分。
    knowledge = body.trim();
    setupHints = '';
  } else {
    knowledge = body.slice(0, setupIndex).trim();
    // 去掉标记本身（从 <!-- SETUP: 到 -->）。
    const afterMarker = body.slice(setupIndex);
    const markerEnd = afterMarker.indexOf('-->');
    setupHints = markerEnd !== -1 ? afterMarker.slice(markerEnd + 3).trim() : afterMarker.trim();
  }

  // 如果存在 <!-- KNOWLEDGE: --> 标记，也把它去掉。
  const knowledgeMarker = '<!-- KNOWLEDGE:';
  if (knowledge.includes(knowledgeMarker)) {
    const markerStart = knowledge.indexOf(knowledgeMarker);
    const markerEnd = knowledge.indexOf('-->', markerStart);
    if (markerEnd !== -1) {
      knowledge =
        knowledge.slice(0, markerStart).trim() + '\n\n' + knowledge.slice(markerEnd + 3).trim();
    }
  }

  return {
    frontmatter,
    knowledge: knowledge.trim(),
    setupHints: setupHints.trim(),
    raw: content,
  };
}

// ============================================================
// 域名提取
// ============================================================

/**
 * 从 URL 中提取主域名。
 * 例如 "https://mcp.linear.app/foo" -> "linear.app"。
 */
export function extractDomainFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // 去掉常见子域名，保留主域。
    const parts = hostname.split('.');
    if (parts.length > 2) {
      // 处理 mcp.linear.app -> linear.app；
      // 同时保留 co.uk 这类二级顶级域，避免误切。
      const twoPartTlds = ['co.uk', 'com.au', 'co.nz', 'com.br'];
      const lastTwo = parts.slice(-2).join('.');
      if (twoPartTlds.includes(lastTwo)) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    }
    return hostname;
  } catch {
    // URL 解析失败时返回 null，表示无法识别。
    return null;
  }
}

/**
 * 从 source 配置中提取域名，用于匹配对应的 guide。
 * source 可以接入 MCP server 或普通 API，因此优先从 URL 里取域，再回退到 provider 字段。
 */
export function extractDomainFromSource(source: {
  type?: string;
  provider?: string;
  mcp?: { url?: string };
  api?: { baseUrl?: string };
}): string | null {
  // 优先尝试 MCP URL。
  // `source.mcp?.url` 是可选链：只有 source.mcp 存在时才访问 url；类似 Go 的 if source.Mcp != nil && source.Mcp.Url != "" 。
  if (source.mcp?.url) {
    const domain = extractDomainFromUrl(source.mcp.url);
    if (domain) return domain;
  }

  // 再尝试 API baseUrl。
  if (source.api?.baseUrl) {
    const domain = extractDomainFromUrl(source.api.baseUrl);
    if (domain) return domain;
  }

  // 最后回退到 provider 字段作为域名提示。
  if (source.provider) {
    // 常见 provider -> 域名的映射表。
    const providerDomains: Record<string, string> = {
      linear: 'linear.app',
      github: 'github.com',
      notion: 'notion.so',
      slack: 'slack.com',
      craft: 'craft.do',
      exa: 'exa.ai',
      google: 'google.com',
    };
    return providerDomains[source.provider.toLowerCase()] || null;
  }

  return null;
}

// ============================================================
// Guide 查找（已弃用 - 请改用 MCP docs）
// ============================================================

/**
 * @deprecated 内建 guide 已移除。
 * 请使用 craft-agents-docs MCP server 搜索 setup guide。
 *
 * 示例：mcp__craft-agents-docs__SearchCraftAgents({ query: "github source setup guide" })
 */
export function getSourceGuideForDomain(_domain: string): ParsedSourceGuide | null {
  // 内建 guide 已移除，现在 guide 来自 MCP docs server。
  return null;
}

/**
 * @deprecated 内建 guide 已移除。
 * 请使用 craft-agents-docs MCP server 搜索 setup guide。
 */
export function getSourceGuide(_source: {
  type?: string;
  provider?: string;
  mcp?: { url?: string };
  api?: { baseUrl?: string };
}): ParsedSourceGuide | null {
  // 内建 guide 已移除，现在 guide 来自 MCP docs server。
  return null;
}

/**
 * @deprecated 内建 guide 已移除。
 * 请使用 craft-agents-docs MCP server 搜索 setup guide。
 */
export function getSourceKnowledge(_source: {
  type?: string;
  provider?: string;
  mcp?: { url?: string };
  api?: { baseUrl?: string };
}): string | null {
  // 内建 guide 已移除，现在 guide 来自 MCP docs server。
  return null;
}
