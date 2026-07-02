/**
 * 文件：domain/index.ts
 * 位置：packages/server-core/src/domain
 * 职责：domain 目录的“桶文件（barrel file）”，统一导出该层所有模块。
 *
 * 架构角色：
 *   - 类似 Go 里一个 package 的公开 API：外部只需要 import package，不需要知道内部文件。
 *   - 在 TS monorepo 中很常见，用于隐藏目录结构、减少调用方的 import 路径。
 *
 * TS 特性：
 *   - `export * from './xxx'` 会把目标模块的所有命名导出重新导出。
 *   - 注意：如果多个文件导出同名符号，会导致编译错误，因此这里文件之间需要保持命名不冲突。
 */

export * from './title-sanitizer'
export * from './browser-tool-detection'
export * from './init-gate'
export * from './session-branch-cleanup'
export * from './session-browser-release'
export * from './connection-setup-logic'
