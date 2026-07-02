/**
 * 基于官方 @modelcontextprotocol/sdk 的 MCP 客户端。
 *
 * 同时支持 HTTP 和 stdio 两种传输：
 * - HTTP：连接远程 MCP server；
 * - stdio：在本地 spawning 一个子进程，通过标准输入输出与其通信。
 *
 * 可以理解为这是“一个 MCP 连接的封装”，类似 Go 里一个持有 net.Conn 的结构体。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// `type` 表示只导入类型，编译后不会生成运行时引用，类似 Go 里 import 类型用 interface。
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * HTTP 传输配置：用于远程 MCP server。
 */
export interface HttpMcpClientConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * stdio 传输配置：用于本地 MCP server，会 spawning 一个子进程。
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * 统一配置类型：两种传输二选一。
 * 类似 Go 里用接口或联合类型表达“要么是 A，要么是 B”。
 */
export type McpClientConfig = HttpMcpClientConfig | StdioMcpClientConfig;

/**
 * 不应透传给 MCP 子进程的敏感环境变量。
 * 这些变量可能包含 API key、token、凭证等，MCP server 不需要、也不应访问。
 *
 * 注意：该列表在 packages/session-tools-core/src/handlers/transform-data.ts（BLOCKED_ENV_VARS）
 * 中也有一份。如果这里新增，请同步更新那里。
 */
const BLOCKED_ENV_VARS = [
  // Craft Agent 自身的认证字段（由 app 自己设置）
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',

  // AWS 凭证
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',

  // 常见 API key / token
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
];

/**
 * 连接池客户端接口：McpClientPool 只依赖这个接口，不关心底层是远程 MCP 还是 API source。
 *
 * 类似 Go 里的 interface：CraftMcpClient 和 ApiSourcePoolClient 都实现它，
 * 上层通过接口调用，方便替换和复用。
 */
export interface PoolClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Craft 的 MCP 客户端实现：负责和真实 MCP server 建立连接、列出工具、调用工具。
 * 实现了 PoolClient 接口，可以被 McpClientPool 管理。
 */
export class CraftMcpClient {
  // MCP SDK 客户端实例。
  private client: Client;

  // 底层传输实例（HTTP 或 stdio）。
  private transport: Transport;

  // 是否已完成连接；避免重复 connect。
  private connected = false;

  constructor(config: McpClientConfig) {
    this.client = new Client({
      name: 'craft-agent',
      version: '1.0.0',
    });

    // 根据配置类型创建对应 transport。
    if (config.transport === 'stdio') {
      // stdio：合并当前进程环境变量，但过滤掉敏感凭证，防止泄露给子进程。
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
          processEnv[key] = value;
        }
      }
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...processEnv, ...config.env },
      });
    } else {
      // HTTP：远程 MCP server，直接传 URL 和 headers。
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      );
    }
  }

  // 建立 MCP 连接；如果已连接则直接返回。
  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect(this.transport);

    // 用 listTools() 做一次健康检查，确认连接真的可用。
    try {
      await this.client.listTools();
    } catch (error) {
      await this.client.close();
      throw new Error(
        `MCP connection failed health check: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.connected = true;
  }

  // 列出该 MCP server 提供的所有工具；未连接时会自动 connect。
  async listTools(): Promise<Tool[]> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.listTools();
    return result.tools;
  }

  /**
   * 返回 MCP 握手阶段服务端上报的 name/version。
   * 只有在 connect() 完成后才有值；否则返回 undefined。
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }

  // 调用指定工具；未连接时会自动 connect。
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  // 关闭连接，并重置 connected 标志。
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
