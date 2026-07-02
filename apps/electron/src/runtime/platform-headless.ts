/**
 * 无头（headless）平台入口。
 *
 * 说明：Electron 应用可以在“无界面”模式下运行（例如纯服务端场景），
 * 这时不需要创建浏览器窗口，只需要一个轻量的平台实现。
 * 这里把 @craft-agent/server-core 提供的 createHeadlessPlatform 重新导出，
 * 供 Electron 主进程或其他入口按需使用。
 *
 * 对比 Golang：类似于把另一个包里的 NewHeadlessPlatform 函数再暴露出去，
 * 让本包成为统一的引用点。
 */
export { createHeadlessPlatform } from '@craft-agent/server-core/runtime'
