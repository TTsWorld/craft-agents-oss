/**
 * 本地 OAuth 回调服务器
 *
 * 在 Electron/终端环境里启动一个临时 HTTP 服务器，监听 localhost 端口，
 * 接收浏览器跳转回来的授权码或错误信息，并返回一个样式化的回调页面。
 */

import { createServer as createHttpServer, type Server } from 'http';
import { URL } from 'url';
import { generateCallbackPage, type AppType } from './callback-page.ts';

// 为了向后兼容，把 callback-page 的导出再导一次
export { generateCallbackPage, type AppType } from './callback-page.ts';

/** 默认起始端口 */
const START_PORT = 6477;
/** 最大端口尝试次数 */
const MAX_PORT_ATTEMPTS = 100;

/**
 * 回调请求负载。
 * 目前只包含 query 参数，未来可以扩展其他请求属性。
 */
export interface CallbackPayload {
  query: Record<string, string>;
}

/**
 * 回调服务器对象：包含一个等待回调结果的 Promise、服务器 URL 和关闭函数。
 */
export interface CallbackServer {
  promise: Promise<CallbackPayload>;
  url: string;
  /** 关闭回调服务器；组件卸载时调用以释放端口 */
  close: () => void | Promise<void>;
}

/**
 * 尝试把 HTTP 服务器绑定到指定端口。
 * 成功时 resolve，失败（如端口被占用）时 reject。
 */
function tryBind(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // bind 地址和 URL 里统一用 'localhost'，避免 127.0.0.1 和 localhost 不匹配
    server.listen(port, 'localhost', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/**
 * 创建回调服务器的选项。
 */
export interface CreateCallbackServerOptions {
  appType?: AppType;
  /** OAuth 成功后跳转的 deeplink，例如 craftagents://auth-complete */
  deeplinkUrl?: string;
  /** 固定端口；如果设置了，只尝试这个端口，不会扫描范围 */
  port?: number;
  /** 接受的回调路径；默认 ['/callback', '/oauth/callback'] */
  callbackPaths?: string[];
}

/**
 * 创建 OAuth 回调服务器。
 *
 * 直接在 START_PORT .. START_PORT + MAX_PORT_ATTEMPTS - 1 范围内尝试绑定真实服务器。
 * 这种方式消除了“先检查再绑定”的 TOCTOU 竞态：如果端口被占用（EADDRINUSE），
 * 关闭候选服务器并尝试下一个端口。
 */
export async function createCallbackServer(options?: CreateCallbackServerOptions): Promise<CallbackServer> {
  const appType = options?.appType ?? 'terminal';
  const deeplinkUrl = options?.deeplinkUrl;
  const allowedPaths = new Set(options?.callbackPaths ?? ['/callback', '/oauth/callback']);

  let server: Server | null = null;
  let boundPort: number | null = null;
  let resolveCallback: ((payload: CallbackPayload) => void) | null = null;
  let rejectCallback: ((error: Error) => void) | null = null;

  // 构造一个 pending 的 Promise，等收到回调后 resolve
  const callbackPromise = new Promise<CallbackPayload>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  // 请求处理器；boundPort 在浏览器打开之前就已经确定，所以这里可以安全闭包使用
  const requestHandler = async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${boundPort}`);

      // 只接受指定回调路径，其他返回 404
      if (!allowedPaths.has(url.pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('Not found');
        return;
      }

      // 把 URLSearchParams 转成普通对象，方便后续处理
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      const payload: CallbackPayload = {
        query,
      };

      // 判断回调是成功还是失败
      const hasCode = !!query.code;
      const hasError = !!query.error;

      // 返回样式化页面
      const html = generateCallbackPage({
        title: hasError ? 'Authorization Failed' : 'Authorization Complete',
        isSuccess: hasCode && !hasError,
        errorDetail: query.error_description || query.error,
        appType,
        deeplinkUrl: (hasCode && !hasError) ? deeplinkUrl : undefined,
      });

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);

      if (server) {
        server.close();
        server = null;
      }

      if (resolveCallback) {
        resolveCallback(payload);
      }
    } catch (error) {
      const html = generateCallbackPage({
        title: 'Error',
        isSuccess: false,
        errorDetail: error instanceof Error ? error.message : 'Internal Server Error',
        appType,
      });

      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);

      if (rejectCallback) {
        rejectCallback(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (server) {
        server.close();
        server = null;
      }
    }
  };

  // 端口选择：固定端口或扫描默认范围
  const fixedPort = options?.port;
  const portStart = fixedPort ?? START_PORT;
  const portAttempts = fixedPort != null ? 1 : MAX_PORT_ATTEMPTS;

  for (let i = 0; i < portAttempts; i++) {
    const port = portStart + i;
    const candidate = createHttpServer(requestHandler);

    try {
      await tryBind(candidate, port);
      // 绑定成功：注册运行时错误处理器，并把错误传播给 callback promise
      server = candidate;
      boundPort = port;
      server.on('error', (err) => {
        rejectCallback?.(err instanceof Error ? err : new Error(String(err)));
      });
      break;
    } catch (err: unknown) {
      // 端口被占用：关闭候选服务器并尝试下一个
      candidate.close();
      const isAddressInUse =
        err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!isAddressInUse) {
        // 非占用错误（如权限不足）直接抛出
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  if (server === null || boundPort === null) {
    if (fixedPort != null) {
      throw new Error(`Port ${fixedPort} is already in use`);
    }
    throw new Error(`No available port found in range ${START_PORT}-${START_PORT + MAX_PORT_ATTEMPTS - 1}`);
  }

  const callbackUrl = `http://localhost:${boundPort}`;

  return {
    promise: callbackPromise,
    url: callbackUrl,
    close: () => {
      if (server) {
        server.close();
        server = null;
      }
    },
  };
}
