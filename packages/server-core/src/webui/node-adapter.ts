/**
 * node-adapter.ts
 *
 * Node HTTP 与 Web Standard Request/Response 之间的适配器。
 *
 * 背景：
 * - WebUI 的核心 handler `createWebuiHandler()` 返回的是 Web 标准 API：
 *   `(req: Request) => Promise<Response>`；
 * - 但 Node 的原生 `http` 模块使用 `(IncomingMessage, ServerResponse) => void`；
 * - 这个 adapter 把两种模型桥接起来，让同一个 handler 既能跑在 Bun 上，
 *   也能挂到 Node 已有的 HTTPS 服务器上（与 WsRpcServer 共享端口）。
 *
 * 与 Go 的类比：
 * - 类似 Go 里把 `http.ResponseWriter + *http.Request` 包装成自定义的
 *   `http.Handler`；或者更直接地说，是把一个 `func(http.ResponseWriter, *http.Request)`
 *   适配成另一个接口形状。
 *
 * TypeScript 要点：
 * - `type WebHandler = (req: Request) => Promise<Response> | Response` 定义了一个函数类型。
 * - `(nodeReq.socket as any).encrypted` 用于判断是否是 HTTPS；`as any` 是类型断言，
 *   因为 Node 的类型定义没有把 `encrypted` 暴露出来，但运行时存在。
 * - `for await (const chunk of nodeReq)` 读取请求体流，类似 Go 的 `io.ReadAll(r.Body)`。
 *
 * Agent 开发关键点：
 * - WebSocket upgrade 请求不会经过这个 adapter，而是由 `ws` 库在 `'upgrade'` 事件层拦截；
 * - Set-Cookie 这种多值头通过 `Headers.forEach` 逐条收集，避免被覆盖；
 * - 适配器内部做了未捕获错误兜底，避免 Node 进程因单个请求异常而崩溃。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

// Web 标准 fetch handler 的函数类型：接收 Request，返回 Response 或其 Promise。
// 类似 Go 的 `type WebHandler func(*http.Request) http.ResponseWriter` 这种签名定义。
type WebHandler = (req: Request) => Promise<Response> | Response

/**
 * 把 Web 标准的 fetch handler 包装成 Node HTTP 请求监听器。
 * WebSocket upgrade 请求不会经过此 adapter —— `ws` 库会在 'upgrade' 事件层拦截它们。
 */
export function nodeHttpAdapter(
  handler: WebHandler,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (nodeReq, nodeRes) => {
    handleRequest(handler, nodeReq, nodeRes).catch((err) => {
      console.error('[webui-adapter] Unhandled error:', err)
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { 'Content-Type': 'text/plain' })
      }
      nodeRes.end('Internal Server Error')
    })
  }
}

/**
 * 把 Node 的 IncomingMessage 转换成 Web 标准 Request，
 * 调用 handler 后，再把 Web 标准 Response 写回 Node ServerResponse。
 */
async function handleRequest(
  handler: WebHandler,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): Promise<void> {
  // 根据 Node 的 IncomingMessage 构建 Web 标准 Request
  const encrypted = !!(nodeReq.socket as any).encrypted
  const protocol = encrypted ? 'https' : 'http'
  const host = nodeReq.headers.host ?? 'localhost'
  const url = `${protocol}://${host}${nodeReq.url ?? '/'}`

  const headers = new Headers()
  const raw = nodeReq.rawHeaders
  // rawHeaders 是 [key, value, key, value, ...] 的扁平数组，步进 2 遍历
  for (let i = 0; i < raw.length; i += 2) {
    headers.append(raw[i], raw[i + 1])
  }

  let body: Buffer | null = null
  if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
    const chunks: Buffer[] = []
    // `for await...of` 读取请求体流，类似 Go 的 `io.ReadAll(r.Body)`
    for await (const chunk of nodeReq) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    body = Buffer.concat(chunks)
  }

  const request = new Request(url, {
    method: nodeReq.method,
    headers,
    body,
  })

  const response = await handler(request)

  // 把 Web 标准 Response 写回 Node ServerResponse。
  // Headers.forEach 会单独遍历每个值，正确处理 Set-Cookie 这类多值头。
  const resHeaders: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    const existing = resHeaders[key]
    if (existing) {
      resHeaders[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value]
    } else {
      resHeaders[key] = value
    }
  })

  nodeRes.writeHead(response.status, resHeaders)

  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    nodeRes.end(buffer)
  } else {
    nodeRes.end()
  }
}
