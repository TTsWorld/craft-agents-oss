/**
 * MCP Pool Server
 *
 * 通过 HTTP 把 McpClientPool 里的工具以 MCP Streamable HTTP 协议暴露出去。
 * 这样外部 SDK 子进程（如 Codex、Copilot）只需连接这一个 HTTP 端点，
 * 就能访问池中管理的所有 MCP source 工具，不用每个 source 单独连。
 *
 * 使用 Streamable HTTP 传输的 stateless（无状态）模式，因为 Codex 采用
 * Streamable HTTP（基于 POST 的 JSON-RPC）。无状态意味着不维护 session，
 * 每个请求互相独立。
 *
 * 架构：
 *   Codex/Copilot SDK 子进程
 *       ↓ (HTTP Streamable HTTP 协议)
 *   McpPoolServer（本文件，在 Electron 主进程中）
 *       ↓
 *   McpClientPool
 *       ↓（每个 source 一条 MCP 连接）
 *   Linear / GitHub / Notion / 等等
 */

// 从 node:http 导入 http server 构造函数；`type Server as HttpServer` 表示只导入类型，
// 编译后不会留下 JS 引用，类似 Go 里给 net/http.Server 起个别名来避免命名冲突。
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpClientPool } from './mcp-pool.ts';

// 把池中的 MCP 工具通过单一 HTTP 服务端暴露给外部 SDK。
export class McpPoolServer {
  // 底层工具连接池，所有工具调用最终都路由到这里。
  private pool: McpClientPool;

  // Node.js HTTP server 实例，start() 时创建。
  private httpServer: HttpServer | null = null;

  // MCP SDK 服务端实例，负责处理 JSON-RPC 请求。
  private mcpServer: Server | null = null;

  // Streamable HTTP 传输层，负责把 HTTP 请求翻译成 MCP 消息。
  private transport: StreamableHTTPServerTransport | null = null;

  // 可选调试日志回调；未传入时保持 undefined，debug() 用可选链 `?.` 安全调用。
  private debugFn: ((msg: string) => void) | undefined;

  // 当前监听的端口；0 表示未启动。
  private _port = 0;

  constructor(pool: McpClientPool, options?: { debug?: (msg: string) => void }) {
    this.pool = pool;
    // `options?.debug` 是 TS 可选链：options 可能为 undefined，有值才取 debug。
    this.debugFn = options?.debug;
  }

  // 私有调试方法，给日志统一加前缀。
  private debug(msg: string): void {
    this.debugFn?.(`[McpPoolServer] ${msg}`);
  }

  // 当前 HTTP 端口，外部可读取。
  get port(): number {
    return this._port;
  }

  // 外部客户端应该连接的 URL，形如 http://127.0.0.1:{port}/mcp。
  get url(): string {
    return `http://127.0.0.1:${this._port}/mcp`;
  }

  /**
   * 启动 HTTP MCP 服务端，绑定到随机端口。
   * 返回客户端应连接的 URL。
   */
  async start(): Promise<string> {
    if (this.httpServer) {
      return this.url;
    }

    // 创建一组 MCP Server + Streamable HTTP transport，使用无状态模式。
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态：不跟踪 session
    });
    this.mcpServer = this.createMcpServer();
    await this.mcpServer.connect(this.transport);

    // 创建 Node HTTP server，把所有 /mcp 路径的请求交给 transport 处理。
    this.httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // 所有 HTTP 方法（POST / GET / DELETE）都交给 Streamable HTTP transport 路由。
      await this.transport!.handleRequest(req, res);
    });

    // 监听随机端口，拿到实际端口号后写入 this._port。
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        this.debug(`Listening on 127.0.0.1:${this._port}`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    return this.url;
  }

  /**
   * 创建并配置一个 MCP Server 实例，所有工具列表和调用都转发到 pool。
   *
   * 池中内部工具名使用 `mcp__craft__search_spaces` 这样的前缀；
   * 这里把 `mcp__` 前缀剥掉，这样 Codex（它会基于 POOL_SERVER_MCP_NAME
   * 再套一层 `mcp__sources__` 前缀）看到的就是干净名字：
   *   池内部:    mcp__craft__search_spaces
   *   这里暴露:  craft__search_spaces
   *   Codex 看到: mcp__sources__craft__search_spaces
   */
  private createMcpServer(): Server {
    const server = new Server(
      { name: 'craft-pool-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // tools/list：从 pool 拿工具定义，去掉 `mcp__` 前缀后返回。
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const proxyDefs = this.pool.getProxyToolDefs();
      return {
        tools: proxyDefs.map(def => ({
          name: def.name.replace(/^mcp__/, ''),
          description: def.description,
          // `as` 是 TS 类型断言：告诉编译器 inputSchema 符合这里的对象形状。
          inputSchema: def.inputSchema as {
            type: 'object';
            properties?: Record<string, unknown>;
          },
        })),
      };
    });

    // tools/call：调用时把 `mcp__` 前缀加回去，再交给 pool 路由到真实 source。
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const internalName = `mcp__${name}`;
      this.debug(`Tool call: ${name} → ${internalName}`);

      const result = await this.pool.callTool(internalName, args || {});

      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    return server;
  }

  /**
   * 通知工具列表已发生变化。
   *
   * 无状态模式下这是个空操作：source 变化会触发 `regenCodexConfigAndReconnect()`，
   * 它会重启 app-server，客户端在下次启动时重新发现工具即可。
   */
  notifyToolsChanged(): void {
    this.debug('Tools changed (stateless mode — clients will discover on next connect)');
  }

  /**
   * 停止 HTTP server 并关闭 transport，释放端口。
   */
  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.close().catch(() => {});
      this.transport = null;
    }

    if (this.mcpServer) {
      await this.mcpServer.close().catch(() => {});
      this.mcpServer = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this._port = 0;
      this.debug('Stopped');
    }
  }
}
