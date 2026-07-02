/**
 * 服务模块入口（barrel 文件）
 *
 * 文件职责：
 *   - 将 services 目录下的各子模块统一导出，方便上层通过 `import { ... } from './services'`
 *     一次性引入。
 *   - 这种文件在 TypeScript/JavaScript 项目中常被称为 barrel / index 文件。
 *
 * 与 Golang 的类比：
 *   - 类似 Golang 中一个 pkg 目录下的 `package services` 把多个子包重新导出，
 *     但 Golang 没有文件级 re-export 语法，通常通过组合类型或 interface 来实现。
 *   - TS 的 `export * from './xxx'` 是编译期语法，不会生成额外运行时代码，
 *     只是改变模块的导出表。
 */
export * from './search'
export * from './image-utils'
export * from './privileged-execution-broker'
export * from './git-bash'
export * from './vcredist'
