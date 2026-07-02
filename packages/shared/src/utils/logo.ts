/**
 * Logo URL 工具
 *
 * 为 API 和 MCP Server 返回 Google Favicon URL。
 * 浏览器负责缓存，无需本地保存文件。
 */

import { debug } from './debug.ts';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { readJsonFileSync } from './files.ts';

// 持久化 provider 域名的缓存路径
const CRAFT_AGENT_DIR = join(homedir(), '.craft-agent');
const PROVIDER_DOMAINS_CACHE_PATH = join(CRAFT_AGENT_DIR, 'provider-domains.json');

// Google Favicon V2 API - 免费、可靠、无需 API key
// 注意：Google 已从 /s2/favicons 迁移到 faviconV2
const GOOGLE_FAVICON_URL = 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=';

/**
 * 需要显式指定图标的 provider 直接 URL。
 * 这些 URL 优先级高于基于域名的 favicon 抓取。
 */
export const PROVIDER_ICON_URLS: Record<string, string> = {
  // Docs 和 Sheets 需要直接 URL——其域名返回通用 Google logo
  docs: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico',
  sheets: 'https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico',
  // Microsoft 服务需要直接 URL——其域名返回通用 favicon
  outlook: 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/outlook_48x1.svg',
  'microsoft-calendar': 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/outlook_48x1.svg',
  teams: 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/teams_48x1.svg',
  sharepoint: 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/sharepoint_48x1.svg',
};

/**
 * 已知 provider 的静态规范域名（不可变）。
 * 将 provider 名映射到其规范域名，用于正确解析 favicon。
 * 可修复 api.gmail.com 返回地球图标而非 Gmail logo 的问题。
 */
const STATIC_PROVIDER_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  // Google 服务 - 同时映射短名和完整 slug
  'gmail': 'mail.google.com',
  'google-calendar': 'calendar.google.com',
  'calendar': 'calendar.google.com',
  'google-drive': 'drive.google.com',
  'drive': 'drive.google.com',
  'google-docs': 'docs.google.com',
  'google-sheets': 'sheets.google.com',
  // Microsoft 服务
  'outlook': 'outlook.live.com',
  'microsoft-calendar': 'outlook.live.com',
  'onedrive': 'onedrive.live.com',
  'teams': 'teams.microsoft.com',
  'sharepoint': 'sharepoint.com',
  // 常见 MCP provider - 它们的 MCP URL 与主域名不同
  'github': 'github.com',
  'linear': 'linear.app',
  'slack': 'slack.com',
  'notion': 'notion.so',
});

// 从 service-url re-export 浏览器安全工具
export { deriveServiceUrl } from './service-url.ts';

/**
 * 持久化 provider 域名的缓存结构。
 */
interface ProviderDomainsCache {
  version: 1;
  domains: Record<string, string>;
  updatedAt: number;
}

/**
 * 从文件系统加载已缓存的 provider 域名。
 */
function loadProviderDomainsCache(): Record<string, string> {
  try {
    if (!existsSync(PROVIDER_DOMAINS_CACHE_PATH)) return {};
    const cache = readJsonFileSync<ProviderDomainsCache>(PROVIDER_DOMAINS_CACHE_PATH);
    return cache.domains || {};
  } catch {
    return {};
  }
}

/**
 * 合并后的 provider 域名缓存（模块私有，带记忆化）。
 * 首次访问时合并用户缓存域名与静态域名。
 */
let _mergedProviderDomains: Record<string, string> | null = null;

/**
 * 获取 provider 的规范域名。
 * 合并静态域名与用户缓存域名（静态优先）。
 *
 * @param provider - provider 名（大小写不敏感）
 * @returns 规范域名；找不到返回 undefined
 */
export function getProviderDomain(provider: string): string | undefined {
  if (!_mergedProviderDomains) {
    const cached = loadProviderDomainsCache();
    _mergedProviderDomains = { ...cached, ...STATIC_PROVIDER_DOMAINS };
    if (Object.keys(cached).length > 0) {
      debug(`[logo] Loaded ${Object.keys(cached).length} cached provider domains`);
    }
  }
  return _mergedProviderDomains[provider.toLowerCase()];
}

/**
 * 重置 provider 域名缓存（供测试使用）。
 * 允许测试用例之间清除缓存状态。
 */
export function _resetProviderDomainCache(): void {
  _mergedProviderDomains = null;
}

/**
 * 从 URL 中提取域名。
 */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * 从主机名中提取根域名（去掉 api.、www. 等子域名）。
 * 例如 "api.github.com" -> "github.com"
 *      "mcp.linear.app" -> "linear.app"
 */
export function extractRootDomain(hostname: string): string {
  const parts = hostname.split('.');

  // 处理特殊 TLD，如 .co.uk、.com.au 等
  const specialTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in'];
  const lastTwo = parts.slice(-2).join('.');

  if (specialTlds.includes(lastTwo) && parts.length > 2) {
    // 返回最后 3 段：example.co.uk
    return parts.slice(-3).join('.');
  }

  // 返回最后 2 段：github.com
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return hostname;
}

/**
 * 常见高分辨率 favicon 路径，按偏好顺序尝试。
 */
const HIGH_RES_FAVICON_PATHS = [
  '/favicon.svg',              // SVG - 质量最佳、可缩放
  '/apple-touch-icon.png',     // 通常 180x180
  '/favicon.png',              // 常见高分辨率 PNG
  '/android-chrome-512x512.png', // 常为 512x512
  '/fluidicon.png',            // GitHub 专用，512x512
  '/icon.svg',                 // 替代 SVG 路径
];

/**
 * 检查 URL 是否存在并返回图片（2xx 且 content-type 为 image/* 时返回 true）。
 */
async function urlExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return false;

    // 确认返回的是图片而非 HTML
    const contentType = response.headers.get('content-type');
    if (!contentType) return false;

    // 接受图片类型（svg、png、ico 等）
    return contentType.startsWith('image/');
  } catch {
    return false;
  }
}

/**
 * 从 HTML <head> 段解析 favicon 链接。
 * 返回 {href, sizes} 对象数组。
 */
async function parseFaviconsFromHtml(url: string): Promise<Array<{href: string, sizes: string | null}>> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' } // 部分站点会拦截 headless 请求
    });

    if (!response.ok) return [];

    const html = await response.text();

    // 提取 <head> 段（基础正则，对 favicon 解析够用）
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch || !headMatch[1]) return [];

    const head = headMatch[1];

    // 查找 rel 包含 "icon" 的所有 <link> 标签
    const linkRegex = /<link\s+([^>]*rel=["'](?:[^"']*\s)?(?:icon|apple-touch-icon)(?:\s[^"']*)?["'][^>]*)>/gi;
    const favicons: Array<{href: string, sizes: string | null}> = [];

    let match;
    while ((match = linkRegex.exec(head)) !== null) {
      const attrs = match[1];
      if (!attrs) continue;

      // 提取 href 属性
      const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch || !hrefMatch[1]) continue;

      let href = hrefMatch[1];

      // 将相对 URL 转为绝对 URL
      if (href.startsWith('//')) {
        href = `https:${href}`;
      } else if (href.startsWith('/')) {
        const origin = new URL(url).origin;
        href = `${origin}${href}`;
      } else if (!href.startsWith('http')) {
        const baseUrl = new URL(url);
        href = `${baseUrl.origin}/${href}`;
      }

      // 提取 sizes 属性（如 "180x180"、"512x512"）
      const sizesMatch = attrs.match(/sizes=["']([^"']+)["']/i);
      const sizes = sizesMatch && sizesMatch[1] ? sizesMatch[1] : null;

      favicons.push({ href, sizes });
    }

    return favicons;
  } catch {
    return [];
  }
}

/**
 * 从解析出的 HTML favicon 链接中挑选最佳图标。
 * 优先 SVG，然后按 sizes 选最大的 PNG/ICO。
 */
function pickBestFavicon(favicons: Array<{href: string, sizes: string | null}>): string | null {
  if (favicons.length === 0) return null;

  // 优先 SVG（可缩放，质量始终最佳）
  const svg = favicons.find(f => f.href.endsWith('.svg'));
  if (svg) return svg.href;

  // 按尺寸从大到小排序
  const withSizes = favicons
    .filter(f => f.sizes && f.sizes !== 'any')
    .map(f => {
      const sizeMatch = f.sizes?.match(/(\d+)x(\d+)/);
      const size = sizeMatch && sizeMatch[1] ? parseInt(sizeMatch[1], 10) : 0;
      return { ...f, sizeNum: size };
    })
    .sort((a, b) => b.sizeNum - a.sizeNum);

  const largestWithSize = withSizes[0];
  if (largestWithSize && largestWithSize.sizeNum >= 128) {
    return largestWithSize.href;
  }

  // 回退到第一个可用
  return favicons[0]?.href ?? null;
}

/**
 * 获取服务的高质量 logo URL。
 * 依次尝试直接 favicon 路径、解析 HTML <head>、最后回退 Google API。
 *
 * 本函数会发起 HTTP 请求以找到最佳 favicon。
 * 结果应被缓存（存入 source 配置），避免重复请求。
 *
 * @param serviceUrl - 服务 URL
 * @param provider - 可选 provider 名（如 'gmail'），用于规范域名映射
 */
export async function getHighQualityLogoUrl(serviceUrl: string, provider?: string): Promise<string | null> {
  // 1. 优先检查 provider 是否有直接图标 URL
  if (provider) {
    const directIconUrl = PROVIDER_ICON_URLS[provider.toLowerCase()];
    if (directIconUrl) {
      // 校验硬编码 URL 是否仍有效（Google 等会不定期更换）
      if (await urlExists(directIconUrl)) {
        return directIconUrl;
      }
      // URL 失效，从映射中删除以免本会话重复尝试
      delete PROVIDER_ICON_URLS[provider.toLowerCase()];
      debug(`[logo] Direct icon URL broken for "${provider}", falling back to favicon API`);
    }

    // 2. 检查 provider 是否有规范域名映射（含缓存域名）
    const canonicalDomain = getProviderDomain(provider);
    if (canonicalDomain) {
      // 用规范域名递归解析 favicon
      return getHighQualityLogoUrl(`https://${canonicalDomain}`);
    }
  }

  const fullDomain = extractDomain(serviceUrl);
  if (!fullDomain) {
    return null;
  }

  // 跳过内部域名
  if (fullDomain === 'localhost' || fullDomain.endsWith('.local') || /^[\d.]+$/.test(fullDomain)) {
    return null;
  }

  const rootDomain = extractRootDomain(fullDomain);
  const hasSubdomain = fullDomain !== rootDomain;

  // 辅助函数：在指定域名上尝试 favicon 路径和 HTML 解析
  async function tryFaviconPaths(domain: string): Promise<string | null> {
    const origin = `https://${domain}`;

    // 尝试高分辨率 favicon 路径
    for (const path of HIGH_RES_FAVICON_PATHS) {
      const url = `${origin}${path}`;
      if (await urlExists(url)) {
        return url;
      }
    }

    // 解析 HTML <head> 中的 favicon 链接
    const favicons = await parseFaviconsFromHtml(origin);
    if (favicons.length > 0) {
      const bestFavicon = pickBestFavicon(favicons);
      if (bestFavicon && await urlExists(bestFavicon)) {
        return bestFavicon;
      }
    }

    return null;
  }

  // 步骤 1：先尝试完整域名（如 mail.google.com）
  if (hasSubdomain) {
    const result = await tryFaviconPaths(fullDomain);
    if (result) {
      return result;
    }
  }

  // 步骤 2：尝试根域名（如 google.com）
  const result = await tryFaviconPaths(rootDomain);
  if (result) {
    return result;
  }

  // 步骤 3：回退到 Google Favicon V2 API（使用完整域名以获得更好结果）
  return `${GOOGLE_FAVICON_URL}128&url=https://${fullDomain}`;
}

/**
 * 获取服务 logo URL（同步版本，使用 Google Favicon API）。
 * 返回 Google Favicon URL；内部域名返回 null。
 *
 * 可能时优先使用 getHighQualityLogoUrl() 获取更高质量图标。
 *
 * @param serviceUrl - 服务 URL
 * @param provider - 可选 provider 名（如 'gmail'），用于规范域名映射
 */
export function getLogoUrl(serviceUrl: string, provider?: string): string | null {
  // 优先检查 provider 是否有直接图标 URL
  if (provider) {
    const directIconUrl = PROVIDER_ICON_URLS[provider.toLowerCase()];
    if (directIconUrl) {
      return directIconUrl;
    }

    // 检查 provider 是否有规范域名映射
    const canonicalDomain = getProviderDomain(provider);
    if (canonicalDomain) {
      return `${GOOGLE_FAVICON_URL}128&url=https://${canonicalDomain}`;
    }
  }

  const fullDomain = extractDomain(serviceUrl);
  if (!fullDomain) {
    return null;
  }

  // 跳过内部域名
  if (fullDomain === 'localhost' || fullDomain.endsWith('.local') || /^[\d.]+$/.test(fullDomain)) {
    return null;
  }

  // 提取根域名（去掉 api.、www. 等子域名）
  const rootDomain = extractRootDomain(fullDomain);

  // 返回 Google Favicon V2 URL - 浏览器负责缓存
  return `${GOOGLE_FAVICON_URL}128&url=https://${rootDomain}`;
}
