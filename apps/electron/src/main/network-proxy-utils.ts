/**
 * network-proxy-utils.ts —— 网络代理纯工具函数（不依赖 Electron）。
 *
 * 解析 NO_PROXY 规则，并判断给定 URL 是否应该绕过代理。
 * 类比 Go：这里相当于 net/http 代理判断逻辑的手动实现。
 */

/** 把逗号分隔字符串拆成去重、去空白的条目数组。 */
export function splitCommaSeparated(str: string | undefined): string[] {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// NO_PROXY 单条规则的结构化表示
export interface NoProxyRule {
  /** 精确主机名或域名后缀（不带前导点）。 */
  host: string;
  /** 可选端口限制。 */
  port?: number;
  /** 为 true 时匹配任意主机（通配符 `*`）。 */
  wildcard: boolean;
}

/**
 * 把 NO_PROXY 字符串解析成结构化规则数组。
 *
 * 支持格式：
 *   - `*`                 → 通配，全部绕过
 *   - `example.com`       → 精确匹配
 *   - `.example.com`      → 后缀匹配（子域名）
 *   - `example.com:8080`  → 主机 + 端口
 *   - `192.168.1.1`       → IP 字面量
 */
export function parseNoProxyRules(noProxy: string | undefined): NoProxyRule[] {
  if (!noProxy) return [];

  return splitCommaSeparated(noProxy)
    .map(entry => entry.toLowerCase())
    .map(entry => {
      if (entry === '*') {
        return { host: '*', wildcard: true };
      }

      // 去掉前导点（视为后缀匹配，与不带点前导效果相同）
      let cleaned = entry.startsWith('.') ? entry.slice(1) : entry;

      // 处理 IPv6：去掉方括号，可选提取尾部端口（如 [::1]:8080）
      if (cleaned.startsWith('[')) {
        const closeBracket = cleaned.indexOf(']');
        if (closeBracket > 0) {
          const ipv6Host = cleaned.slice(1, closeBracket);
          const afterBracket = cleaned.slice(closeBracket + 1);
          if (afterBracket.startsWith(':')) {
            const port = parseInt(afterBracket.slice(1), 10);
            if (!isNaN(port)) {
              return { host: ipv6Host, port, wildcard: false };
            }
          }
          return { host: ipv6Host, wildcard: false };
        }
      }

      // 检查非 IPv6 的端口
      const lastColon = cleaned.lastIndexOf(':');
      if (lastColon > 0) {
        const host = cleaned.slice(0, lastColon);
        const port = parseInt(cleaned.slice(lastColon + 1), 10);
        if (!isNaN(port)) {
          return { host, port, wildcard: false };
        }
      }

      return { host: cleaned, wildcard: false };
    });
}

/**
 * 根据 NO_PROXY 规则判断 URL 是否应该绕过代理。
 */
/** 各协议默认端口，URL 没写端口时使用。 */
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

export function shouldBypassProxy(url: string | URL, rules: NoProxyRule[]): boolean {
  if (rules.length === 0) return false;

  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = parsed.hostname.toLowerCase();
  // 去掉 IPv6 方括号
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : DEFAULT_PORTS[parsed.protocol];

  for (const rule of rules) {
    if (rule.wildcard) return true;

    // 带端口限定的规则：只有端口匹配时才继续匹配 host
    if (rule.port !== undefined && rule.port !== port) {
      continue;
    }

    // 精确匹配
    if (host === rule.host) return true;

    // 后缀匹配（子域名）：host 以 .rule.host 结尾
    if (host.endsWith(`.${rule.host}`)) return true;
  }

  return false;
}
