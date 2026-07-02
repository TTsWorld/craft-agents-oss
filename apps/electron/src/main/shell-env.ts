/**
 * shell-env.ts —— Shell 环境加载器。
 *
 * macOS 上从 Finder/Dock 启动的 Electron 应用继承的是最小化的 launchd 环境，
 * PATH 通常只有 /usr/bin:/bin:/usr/sbin:/sbin。
 *
 * 本模块通过启动用户的 login shell 来加载完整环境变量，确保 Homebrew、nvm、
 * pyenv 等工具对 agent 可用。
 */

import { execSync } from 'child_process'
import { mainLog } from './logger'

// 不应从 shell 导入的环境变量：dev 模式的 VITE_* 会让打包后的应用错误连接 localhost
const shouldSkipEnvVar = (key: string): boolean => {
  return key.startsWith('VITE_')
}

/**
 * 加载用户 shell 环境并合并到 process.env。
 *
 * 应在 app 启动早期、创建任何 agent 之前调用。
 * 它启动用户的 login shell，获取完整环境，包括 .zshrc / .bashrc / .zprofile 里的 PATH 修改。
 */
export function loadShellEnv(): void {
  // 只有 macOS 需要从 GUI 启动时补环境
  if (process.platform !== 'darwin') {
    return
  }

  // dev 模式从终端启动，环境已经完整，跳过
  if (process.env.VITE_DEV_SERVER_URL) {
    mainLog.info('[shell-env] Skipping in dev mode (already have shell environment)')
    return
  }

  const shell = process.env.SHELL || '/bin/zsh'
  mainLog.info(`[shell-env] Loading environment from ${shell}`)

  try {
    // 启动 login shell 获取完整环境
    // -l = login shell，会加载 .zprofile 等 profile 文件
    // -i = interactive shell，会加载 .zshrc 等 rc 文件
    // 用 __ENV_START__ 标记把 shell 启动输出和 env 输出分开
    const output = execSync(`${shell} -l -i -c 'echo __ENV_START__ && env'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: shell,
        TERM: 'xterm-256color',
        TMPDIR: process.env.TMPDIR,
        // 防止 shell 调用 /usr/bin/git shim 时弹出「安装命令行开发者工具」对话框
        APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 解析标记之后的环境变量行，跳过被屏蔽的变量
    const envSection = output.split('__ENV_START__')[1] || ''
    let count = 0
    for (const line of envSection.trim().split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) {
        const key = line.substring(0, eq)
        if (shouldSkipEnvVar(key)) continue
        const value = line.substring(eq + 1)
        process.env[key] = value
        count++
      }
    }

    mainLog.info(`[shell-env] Loaded ${count} environment variables`)

    // 调试时记录 PATH
    if (process.env.PATH) {
      const pathCount = process.env.PATH.split(':').length
      mainLog.info(`[shell-env] PATH has ${pathCount} entries`)
    }
  } catch (error) {
    // shell 环境加载失败不应阻塞启动
    mainLog.warn(`[shell-env] Failed to load shell environment: ${error}`)
    mainLog.warn('[shell-env] Adding common paths as fallback')

    // 兜底：加入几个常见路径
    const fallbackPaths = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.bun/bin`,
      `${process.env.HOME}/.cargo/bin`,
    ]

    const currentPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
    const newPath = [...fallbackPaths, ...currentPath.split(':')]
      .filter((p, i, arr) => arr.indexOf(p) === i) // 去重
      .join(':')

    process.env.PATH = newPath
  }
}
