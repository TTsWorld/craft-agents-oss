import { getNetworkProxySettings } from './storage.ts';

/**
 * 把存储的代理设置转换成子进程用的环境变量。
 *
 * 如果代理未启用或未配置，返回空对象。命名同时给出大写和小写形式，
 * 兼容大多数 HTTP 库（类似 curl / wget 的惯例）。
 */
export function getProxyEnvVars(): Record<string, string> {
  const settings = getNetworkProxySettings();
  if (!settings?.enabled) return {};

  const env: Record<string, string> = {};
  if (settings.httpProxy) {
    env.HTTP_PROXY = settings.httpProxy;
    env.http_proxy = settings.httpProxy;
  }
  if (settings.httpsProxy) {
    env.HTTPS_PROXY = settings.httpsProxy;
    env.https_proxy = settings.httpsProxy;
  }
  if (settings.noProxy) {
    env.NO_PROXY = settings.noProxy;
    env.no_proxy = settings.noProxy;
  }
  return env;
}
