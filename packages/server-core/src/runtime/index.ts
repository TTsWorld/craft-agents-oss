/**
 * runtime 平台抽象模块入口。
 *
 * 这个包把 Electron 和 headless 环境的能力抽象成统一接口，
 * 让核心代码不直接依赖 electron 包。
 */
export * from './platform.ts'
export * from './platform-headless.ts'
export * from './null-browser-pane-manager.ts'
