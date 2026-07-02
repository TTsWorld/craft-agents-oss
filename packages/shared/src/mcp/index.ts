/**
 * MCP（Model Context Protocol）模块的统一入口。
 *
 * 这里只是把子模块的公开导出集中 re-export，方便外部通过 `@craft-agent/shared/mcp` 使用。
 * 相当于 Go 里一个 package 的 `init` 聚合层：本身不含逻辑，只负责暴露接口。
 */

export * from './client.ts';
export * from './mcp-pool.ts';
export * from './pool-server.ts';
export * from './validation.ts';
