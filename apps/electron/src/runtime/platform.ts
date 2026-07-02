/**
 * 平台能力抽象入口。
 *
 * 说明：Electron 作为桌面应用，需要访问文件系统、打开外部链接、处理图片等
 * 原生能力。server-core 把这些能力抽象成 PlatformServices 接口，
 * Electron 侧负责提供具体实现（见 main/platform.ts）。
 * 本文件只做“转发”：把类型和工具函数从 @craft-agent/server-core/runtime
 * 集中导出，方便其他模块统一引用。
 */

// export type { ... } 是 TypeScript 的“仅类型导出”。
// 它不会生成运行时代码，只在编译期提供类型信息；
// 类似于 Golang 里把另一个包的 interface/type alias 再暴露一次。
export type {
  // 日志接口：定义了 info/warn/error 等方法，和 Go 的 logger 接口角色类似。
  Logger,
  // 图片处理接口：例如读取尺寸、缩放、转格式。
  ImageProcessor,
  // 平台能力总接口：Electron 会实现它，把原生 API 注入到 server-core。
  PlatformServices,
} from '@craft-agent/server-core/runtime'

// export { ... } 是值导出，会在运行期真实存在，可以被其他模块 import 后调用。
export {
  // 创建带作用域的日志实例，常用于给不同模块的日志加前缀。
  createScopedLogger,
  // 直接输出到控制台的日志实现，相当于一个默认的 logger 实例。
  CONSOLE_LOGGER,
} from '@craft-agent/server-core/runtime'
