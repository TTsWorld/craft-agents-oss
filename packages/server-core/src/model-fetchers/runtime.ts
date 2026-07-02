/**
 * 模型拉取器运行时辅助模块
 *
 * 文件职责：
 *   - 为 model-fetchers 子模块提供延迟初始化的 PlatformServices 与 logger。
 *   - 单独抽出本文件是为了避免循环依赖：
 *     index.ts → registry.ts → anthropic.ts/pi.ts → runtime.ts，
 *     而不是直接回到 index.ts。
 *     这与 Golang 中把公共依赖下沉到 pkg/runtime 层、避免 import cycle 的思路一致。
 *
 * TS 特性小记：
 *   - `export let handlerLog` 使用 ES module 的“活绑定”：模块导出的不是快照，
 *     而是对变量的引用；调用 setFetcherPlatform() 重新赋值后，其他模块再次读取
 *     会拿到新值。Golang 的包级变量没有这种绑定语义，重新赋值后同样生效，但
 *     机制不同（Golang 是运行时直接访问包级变量）。
 *   - `type PlatformServices` 是 TypeScript 的类型导入，编译后擦除，不影响运行时。
 */
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '../runtime/platform'

/** 模块级 PlatformServices 引用；必须在首次 model fetching 前通过 setFetcherPlatform() 注入 */
let _platform: PlatformServices | null = null

/**
 * 带作用域的日志器。
 * 初始使用 CONSOLE_LOGGER 兜底；setFetcherPlatform() 注入真实平台 logger 后自动升级。
 */
export let handlerLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'handler')

/**
 * 注入平台服务。
 * @param platform - 包含 logger、appRootPath、resourcesPath、isPackaged 的运行时上下文
 */
export function setFetcherPlatform(platform: PlatformServices): void {
  _platform = platform
  handlerLog = createScopedLogger(platform.logger, 'handler')
}

/**
 * 获取后端运行时需要的路径信息。
 * @throws 若 setFetcherPlatform() 尚未调用则抛出错误
 */
export function getHostRuntime() {
  if (!_platform) throw new Error('setFetcherPlatform() must be called before model fetching')
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    isPackaged: _platform.isPackaged,
  }
}
