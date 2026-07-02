/** electron-log 浏览器垫片：把日志转发到 console。 */
export default {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
  verbose: console.debug.bind(console),
  silly: console.debug.bind(console),
  log: console.log.bind(console),
  // ipc 传输在浏览器里禁用
  transports: { ipc: { level: false } },
  // scope 返回一个带作用域的日志对象（这里简单复用 console）
  scope: () => ({
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }),
}
