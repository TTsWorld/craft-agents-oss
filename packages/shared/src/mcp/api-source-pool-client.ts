/**
 * API source 的连接池客户端。
 *
 * 它通过内存传输（in-memory transport）连接一个同进程内的 McpServer
 *（由 createSdkMcpServer 创建），并暴露和 CraftMcpClient 一样的 PoolClient 接口，
 * 这样 McpClientPool 可以用同一套逻辑管理远程 MCP source 和本地 API source。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// `type` 表示只导入类型，不生成运行时引用。
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { PoolClient } from './client.ts';

/**
 * API source 的池客户端实现。
 * 和 CraftMcpClient 一样实现 PoolClient 接口，方便被 McpClientPool 复用。
 */
export class ApiSourcePoolClient implements PoolClient {
  // MCP SDK 客户端实例。
  private client: Client;

  // 是否已完成连接。
  private connected = false;

  // 构造函数参数前的 `private` 是 TS 简写：同时声明形参和同名字段并赋值。
  // 类似 Go 里把参数直接存到结构体字段。
  constructor(private mcpServer: McpServer) {
    this.client = new Client({ name: 'craft-pool-api-source', version: '1.0.0' });
  }

  // 建立内存连接：创建一对关联的 transport，分别连 server 端和 client 端。
  async connect(): Promise<void> {
    if (this.connected) return;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // 同时连上服务端和客户端两端。
    await this.mcpServer.connect(serverTransport);
    await this.client.connect(clientTransport);

    this.connected = true;
  }

  // 列出工具；未连接时自动 connect。
  async listTools(): Promise<Tool[]> {
    if (!this.connected) await this.connect();
    const result = await this.client.listTools();
    return result.tools;
  }

  // 调用工具；未连接时自动 connect。
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();
    return this.client.callTool({ name, arguments: args });
  }

  // 关闭连接；忽略关闭过程中可能出现的异常。
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close().catch(() => {});
      this.connected = false;
    }
  }
}
