/**
 * core 包的调试工具（占位实现）。
 *
 * 目前是一个空操作（no-op），真正的日志功能在 @craft-agent/shared 里。
 * 留这个占位是为了保持 core 包的 API 统一，未来可以接入 process.env.DEBUG 等机制。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debug(..._args: any[]): void {
  // 默认什么都不做
  // 未来可以在这里根据 process.env.DEBUG 输出调试日志
}
