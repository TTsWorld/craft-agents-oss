/**
 * Node.js 内置模块的浏览器空垫片。
 *
 * @craft-agent/shared 里有些代码静态 import 了 Node.js 模块（如 fs、path），
 * 但这些代码路径只在服务端执行。在浏览器里，web API 适配器会先拦截所有调用，
 * 不会真正走到这些 Node 代码里。
 *
 * 这些垫片只是为了满足打包器（bundler）的静态分析，同时不增加运行时体积。
 */

// fs：提供同名函数，大多是空实现或抛错
export const readFileSync = () => { throw new Error('readFileSync not available in browser') }
export const writeFileSync = () => { throw new Error('writeFileSync not available in browser') }
export const existsSync = () => false
export const statSync = () => { throw new Error('statSync not available in browser') }
export const unlinkSync = () => {}
export const mkdtempSync = () => ''
export const renameSync = () => {}
export const mkdirSync = () => {}
export const readdirSync = () => []
export const readdir = () => {}
export const copyFileSync = () => {}
export const promises = {
  readFile: async () => { throw new Error('fs.promises not available in browser') },
  writeFile: async () => { throw new Error('fs.promises not available in browser') },
  mkdir: async () => {},
  readdir: async () => [],
  stat: async () => { throw new Error('fs.promises not available in browser') },
  access: async () => { throw new Error('fs.promises not available in browser') },
  rm: async () => {},
  unlink: async () => {},
}

// path：极简实现，用 '/' 做分隔符
export const join = (...parts: string[]) => parts.filter(Boolean).join('/')
export const resolve = (...parts: string[]) => parts.filter(Boolean).join('/')
export const basename = (p: string) => p.split('/').pop() ?? ''
export const dirname = (p: string) => p.split('/').slice(0, -1).join('/')
export const extname = (p: string) => { const m = p.match(/\.[^.]+$/); return m ? m[0] : '' }
export const relative = (from: string, to: string) => to
export const sep = '/'
export const isAbsolute = (p: string) => p.startsWith('/')
export const normalize = (p: string) => p
export const parse = (p: string) => ({ root: '', dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p).replace(/\.[^.]+$/, '') })
export const format = (obj: { dir?: string; base?: string }) => [obj.dir, obj.base].filter(Boolean).join('/')
export const posix = { join, resolve, basename, dirname, extname, relative, sep, isAbsolute, normalize, parse, format }
export const win32 = posix

// child_process
export const execSync = () => { throw new Error('execSync not available in browser') }
export const exec = () => { throw new Error('exec not available in browser') }
export const spawn = () => { throw new Error('spawn not available in browser') }

// os：返回一些占位值，避免上层代码读取时崩溃
export const homedir = () => '/home/user'
export const tmpdir = () => '/tmp'
export const platform = () => 'linux'
export const hostname = () => 'browser'
export const cpus = () => [{}]

// crypto：基础实现，随机相关功能委托给 Web Crypto
export const randomBytes = (n: number) => {
  const buf = new Uint8Array(n)
  globalThis.crypto.getRandomValues(buf)
  return buf
}
export const randomUUID = () => globalThis.crypto.randomUUID()
export const createHash = () => ({
  update: function(this: any) { return this },
  digest: () => '',
})
export const createHmac = () => ({
  update: function(this: any) { return this },
  digest: () => '',
})
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]
  return result === 0
}

// https / http：只在服务端代码里被 import，浏览器端不会执行
export const createServer = () => { throw new Error('createServer not available in browser') }
export const request = () => { throw new Error('request not available in browser') }
export const get = () => { throw new Error('get not available in browser') }

// util
export const promisify = (fn: any) => fn
export const inspect = (obj: any) => String(obj)
export const deprecate = (fn: any) => fn
export const inherits = () => {}

// buffer：用 Uint8Array 模拟 Buffer 的部分接口
export const Buffer = {
  from: (data: any) => new Uint8Array(typeof data === 'string' ? new TextEncoder().encode(data) : data),
  isBuffer: () => false,
  alloc: (size: number) => new Uint8Array(size),
  concat: (bufs: Uint8Array[]) => {
    const total = bufs.reduce((acc, b) => acc + b.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const buf of bufs) { result.set(buf, offset); offset += buf.length }
    return result
  },
}

// process
export const env = typeof globalThis.process !== 'undefined' ? globalThis.process.env : {}
export const cwd = () => '/'
export const argv = []
export const pid = 0
export const kill = () => {}
export const exit = () => {}
export const on = () => {}

// Events：WebSocketServer 会 import EventEmitter，这里提供一个最小实现
export class EventEmitter {
  private _events: Record<string, Function[]> = {}
  on(event: string, fn: Function) { (this._events[event] ??= []).push(fn); return this }
  off(event: string, fn: Function) { this._events[event] = (this._events[event] ?? []).filter(f => f !== fn); return this }
  emit(event: string, ...args: any[]) { (this._events[event] ?? []).forEach(fn => fn(...args)); return true }
  removeAllListeners() { this._events = {}; return this }
  addListener(event: string, fn: Function) { return this.on(event, fn) }
  removeListener(event: string, fn: Function) { return this.off(event, fn) }
  listeners(event: string) { return this._events[event] ?? [] }
}

export default {}
