/**
 * network-proxy.ts —— 网络代理管理器。
 *
 * 同时配置 Node.js（undici）和 Electron session 的代理：
 * - Node 侧：把全局 undici dispatcher 换成 ProtocolProxyDispatcher，按协议走不同 ProxyAgent，并尊重 NO_PROXY。
 * - Electron 侧：对默认 session 和 browser-pane 分区调用 session.setProxy()。
 */

import { app, session } from 'electron';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import { parseNoProxyRules, shouldBypassProxy, splitCommaSeparated, type NoProxyRule } from './network-proxy-utils';
import { getNetworkProxySettings, setNetworkProxySettings } from '@craft-agent/shared/config/storage';
import type { NetworkProxySettings } from '@craft-agent/shared/config/types';
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager';
import log from './logger';

// 保存当前 dispatcher，重新配置时先关闭，避免资源泄漏
let currentProxyDispatcher: Dispatcher | null = null;

/**
 * 自定义 undici Dispatcher：按协议选择 HTTP/HTTPS 代理、遵守 NO_PROXY、无法匹配时直连。
 */
class ProtocolProxyDispatcher extends Dispatcher {
  private httpProxy: ProxyAgent | null;
  private httpsProxy: ProxyAgent | null;
  private direct: Agent;
  private rules: NoProxyRule[];

  constructor(opts: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
  }) {
    super();
    this.httpProxy = opts.httpProxy ? new ProxyAgent(opts.httpProxy) : null;
    this.httpsProxy = opts.httpsProxy ? new ProxyAgent(opts.httpsProxy) : null;
    this.direct = new Agent();
    this.rules = parseNoProxyRules(opts.noProxy);
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const url = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString();

    // 如果 URL 匹配绕过规则，直接连接
    if (url && shouldBypassProxy(url, this.rules)) {
      return this.direct.dispatch(opts, handler);
    }

    // 按协议选择代理
    const isHttps = url?.startsWith('https:');
    const proxy = isHttps ? (this.httpsProxy ?? this.httpProxy) : this.httpProxy;

    if (proxy) {
      return proxy.dispatch(opts, handler);
    }

    return this.direct.dispatch(opts, handler);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.httpProxy?.close(),
      this.httpsProxy?.close(),
      this.direct.close(),
    ]);
  }

  async destroy(): Promise<void> {
    await Promise.all([
      this.httpProxy?.destroy(),
      this.httpsProxy?.destroy(),
      this.direct.destroy(),
    ]);
  }
}

/**
 * 配置 Node.js 全局 undici dispatcher 的代理路由。
 */
function configureNodeProxy(settings: NetworkProxySettings | undefined): void {
  // 关闭之前的 dispatcher（代理或直连都会被追踪）
  if (currentProxyDispatcher) {
    currentProxyDispatcher.close().catch(() => {});
    currentProxyDispatcher = null;
  }

  if (!settings?.enabled || (!settings.httpProxy && !settings.httpsProxy)) {
    // 恢复直连 dispatcher 并追踪，以便下次重新配置时可以关闭
    const direct = new Agent();
    setGlobalDispatcher(direct);
    currentProxyDispatcher = direct;
    return;
  }

  const dispatcher = new ProtocolProxyDispatcher({
    httpProxy: settings.httpProxy,
    httpsProxy: settings.httpsProxy,
    noProxy: settings.noProxy,
  });

  setGlobalDispatcher(dispatcher);
  currentProxyDispatcher = dispatcher;
}

/**
 * 配置 Electron session 代理（默认 session + browser-pane 分区）。
 * 需要 app 已 ready。
 */
async function configureElectronProxy(settings: NetworkProxySettings | undefined): Promise<void> {
  if (!app.isReady()) return;

  const proxyConfig = settings?.enabled
    ? buildElectronProxyConfig(settings)
    : { mode: 'direct' as const };

  const sessions = [
    session.defaultSession,
    session.fromPartition(BROWSER_PANE_SESSION_PARTITION),
  ];

  await Promise.all(sessions.map(ses => ses.setProxy(proxyConfig)));
}

function buildElectronProxyConfig(settings: NetworkProxySettings): Electron.ProxyConfig {
  const rules: string[] = [];

  if (settings.httpsProxy) {
    rules.push(`https=${settings.httpsProxy}`);
  }
  if (settings.httpProxy) {
    rules.push(`http=${settings.httpProxy}`);
  }

  if (rules.length === 0) {
    return { mode: 'direct' };
  }

  return {
    mode: 'fixed_servers',
    proxyRules: rules.join(';'),
    proxyBypassRules: settings.noProxy
      ? splitCommaSeparated(settings.noProxy).join(',')
      : undefined,
  };
}

/**
 * 读取持久化的代理设置并同时应用到 Node 和 Electron。
 * app.whenReady() 之前调用也安全：Electron session 部分会等到 ready 后再执行。
 */
export async function applyConfiguredProxySettings(): Promise<void> {
  const settings = getNetworkProxySettings();

  const hasHttpProxy = !!settings?.httpProxy;
  const hasNoProxy = !!settings?.noProxy;
  log.info('[proxy] Applying proxy settings:', {
    enabled: settings?.enabled ?? false,
    hasHttpProxy,
    hasHttpsProxy: !!settings?.httpsProxy,
    hasNoProxy,
  });

  configureNodeProxy(settings);
  await configureElectronProxy(settings);
}

/**
 * 持久化新的代理设置并立即应用。
 */
export async function updateConfiguredProxySettings(settings: NetworkProxySettings): Promise<void> {
  setNetworkProxySettings(settings);
  await applyConfiguredProxySettings();
}
