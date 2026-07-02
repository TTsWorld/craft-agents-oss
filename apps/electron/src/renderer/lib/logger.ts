/**
 * 渲染进程日志封装。
 * 基于 electron-log/renderer，提供按作用域划分的 logger 实例。
 */

import log from 'electron-log/renderer'

// 导出带作用域的 logger，方便在渲染进程不同模块中区分日志来源
export const rendererLog = log.scope('renderer')
export const searchLog = log.scope('search')

export default log
