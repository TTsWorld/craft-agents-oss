/**
 * 应用全局布局常量：统一间距、尺寸等视觉参数。
 *
 * 与聊天相关的布局常量从 @craft-agent/ui 包导入，
 * 这样 Electron 端和 web viewer 端能保持一致。
 */

// 从 UI 包重新导出聊天布局常量（re-export，类似 Go 的再导出）
export { CHAT_LAYOUT, CHAT_CLASSES } from '@craft-agent/ui'
