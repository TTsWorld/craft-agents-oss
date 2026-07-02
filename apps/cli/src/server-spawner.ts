/**
 * Server spawner —— 以后台子进程方式启动一个无界面的 Craft Agent 服务端。
 *
 * 可以理解为 Go 里用 exec.Command 启动一个子服务：通过 `bun run <serverEntry>` 拉起服务，
 * 监听 stdout 里打印的 `CRAFT_SERVER_URL=` 和 `CRAFT_SERVER_TOKEN=` 行，
 * 拿到地址后返回一个 handle，调用方可以调用 stop() 结束进程。
 */

import { resolve, join } from 'node:path'
import type { Subprocess } from 'bun'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 已启动服务的句柄。类似 Go 的 struct 返回值。 */
export interface SpawnedServer {
  url: string
  token: string
  stop: () => Promise<void>
}

/** spawnServer 的可选参数。 */
export interface SpawnServerOptions {
  /** 服务端入口文件路径。省略时自动从 monorepo 根目录推导。 */
  serverEntry?: string
  /** 传给服务端子进程的额外环境变量。 */
  env?: Record<string, string>
  /** 等待服务端打印 URL 的最长时间（毫秒），默认 30000。 */
  startupTimeout?: number
  /** 安静模式：在集成测试中抑制服务端 stderr 输出。 */
  quiet?: boolean
}

// ---------------------------------------------------------------------------
// 自动推导服务端入口
// ---------------------------------------------------------------------------

/** 从当前文件向上回溯目录树，尝试定位 packages/server/src/index.ts。 */
function findServerEntry(): string {
  // 预期目录结构：apps/cli/src/server-spawner.ts → root/packages/server/src/index.ts
  let dir = import.meta.dir
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'packages', 'server', 'src', 'index.ts')
    if (Bun.file(candidate).size > 0) return candidate
    dir = resolve(dir, '..')
  }
  throw new Error(
    'Could not auto-detect server entry. ' +
    'Pass --server-entry or ensure the monorepo layout includes packages/server/src/index.ts',
  )
}

// ---------------------------------------------------------------------------
// 启动服务
// ---------------------------------------------------------------------------

/** 启动服务端子进程，返回服务 URL、token 和停止函数。 */
export async function spawnServer(opts?: SpawnServerOptions): Promise<SpawnedServer> {
  const serverEntry = opts?.serverEntry ?? findServerEntry()
  const startupTimeout = opts?.startupTimeout ?? 30_000
  const token = crypto.randomUUID()

  // 去掉 CLAUDECODE 环境变量，防止在 Claude Code 会话里启动子服务时触发嵌套守护导致被拒绝。
  const { CLAUDECODE: _, ...parentEnv } = process.env
  const proc: Subprocess = Bun.spawn(['bun', 'run', serverEntry], {
    env: {
      ...parentEnv,
      ...opts?.env,
      CRAFT_SERVER_TOKEN: token,
      CRAFT_RPC_PORT: '0', // 0 表示让系统随机分配可用端口
      CRAFT_RPC_HOST: '127.0.0.1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // 把服务端 stderr 透传到当前进程（quiet 模式下关闭），方便看 --debug 日志。
  if (proc.stderr && !opts?.quiet) {
    ;(async () => {
      // @ts-expect-error —— Bun 的 Subprocess 类型无法将 stderr: 'pipe' 收窄为 ReadableStream
      const reader = proc.stderr.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          process.stderr.write(value)
        }
      } catch {
        // 服务已退出，这是正常情况
      }
    })()
  }

  // 按行读取 stdout，直到匹配到 CRAFT_SERVER_URL= 才算启动成功
  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Server did not start within ${startupTimeout}ms`))
    }, startupTimeout)

    let url = ''
    let buffer = ''

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 最后一行可能不完整，先留在缓冲区
      for (const line of lines) {
        if (line.startsWith('CRAFT_SERVER_URL=')) {
          url = line.slice('CRAFT_SERVER_URL='.length).trim()
        }
        if (line.startsWith('CRAFT_SERVER_TOKEN=')) {
          // 服务端会回显 token，这里不需要额外处理，但能确认服务已就绪
        }
        // 拿到 URL 即认为服务已可接受连接
        if (url) {
          clearTimeout(timer)
          resolve({
            url,
            token,
            stop: async () => {
              proc.kill('SIGTERM')
              await proc.exited
            },
          })
          return
        }
      }
    }

    ;(async () => {
      // @ts-expect-error —— Bun 的 Subprocess 类型无法将 stdout: 'pipe' 收窄为 ReadableStream
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          processLines()
        }
      } catch {
        // 流已关闭
      }
      // 正常走到这里说明进程退出了；如果还没拿到 url，就按启动失败处理
      clearTimeout(timer)
      if (!url) {
        reject(new Error('Server process exited before printing CRAFT_SERVER_URL'))
      }
    })()
  })
}
