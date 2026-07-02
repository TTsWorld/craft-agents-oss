/**
 * Electron renderer 进程入口文件。
 *
 * renderer 是 Electron 的“前端”进程，负责渲染 UI；main 进程负责 Node/Electron 原生能力。
 * 这里完成：i18n 初始化、Sentry 错误上报、Jotai 状态提供、主题提供、React 根组件挂载。
 * 对 Go 同学：可以把 renderer 理解为最终用户直接面对的 HTTP 前端服务，main 是后端服务。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { init as sentryInit } from '@sentry/electron/renderer'
import * as Sentry from '@sentry/react'
import { captureConsoleIntegration } from '@sentry/react'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import { windowWorkspaceIdAtom } from './atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import { setupI18n, i18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import './index.css'

// 在任何 React 渲染前先初始化国际化（i18n）。
// LanguageDetector 会自动从 localStorage 或浏览器语言推断当前语言。
setupI18n([LanguageDetector, initReactI18next])

// 一次性引导：让 main 进程的 i18n 和 preferences.json 也能学到我们从 localStorage 恢复的语言。
// main 进程的 IPC 处理器会校验语言码并幂等持久化，因此每次 renderer 启动都执行是安全的。
// 如果不做这次推送，新安装或升级后的应用在用户重新到 Appearance 选择语言前都会用英文生成标题。
const resolvedLanguage = i18n.resolvedLanguage

// 诊断日志：把引导推送打印到 DevTools，并通过 captureConsoleIntegration 送进 Sentry，
// 与 main 进程的 [i18n] 启动 hydration 日志对齐。如果两者不一致，说明 renderer 的 localStorage
// 没有跟踪到用户在 Appearance 中的选择。
console.info('[i18n] renderer bootstrap push', {
  resolvedLanguage: resolvedLanguage ?? null,
  localStorageI18nextLng: typeof window !== 'undefined' ? window.localStorage?.getItem('i18nextLng') : null,
})
if (resolvedLanguage) {
  // `void` 表示“显式忽略返回的 Promise”。这里只是通知 main 进程，不需要 await。
  void window.electronAPI?.changeLanguage?.(resolvedLanguage)
}

// 已知无害、不应上报到 Sentry 的 console 消息。
// 包括开发模式噪音或预期中的警告，它们不具备可行动性。
const IGNORED_CONSOLE_PATTERNS = [
  // React StrictMode 对非布尔 DOM 属性的开发警告
  'Received `true` for a non-boolean attribute',
  'Received `false` for a non-boolean attribute',
  // Shiki 主题重复注册（HMR 热重载时预期出现）
  'theme name already registered',
]

// 在 renderer 进程中初始化 Sentry，采用双初始化模式：
// - sentryInit 提供 Electron IPC 传输
// - Sentry.init 提供 React 错误边界支持
// DSN 和配置继承自主进程的初始化。
//
// captureConsoleIntegration 会把 console.error 提升为 Sentry 事件，
// 让 Sentry 拥有与 DevTools 同样丰富的上下文，且无需 sourcemap。
//
// 注意：source map 上传被有意禁用，详见 main/index.ts。
sentryInit(
  {
    integrations: [captureConsoleIntegration({ levels: ['error'] })],

    beforeSend(event) {
      // 过滤掉已知无害的 console 模式，避免浪费 Sentry 配额
      const message = event.message || event.exception?.values?.[0]?.value || ''
      if (IGNORED_CONSOLE_PATTERNS.some((pattern) => message.includes(pattern))) {
        return null
      }

      // 从 breadcrumbs 中擦除敏感数据（与 main/index.ts 中的处理保持一致）
      if (event.breadcrumbs) {
        for (const breadcrumb of event.breadcrumbs) {
          if (breadcrumb.data) {
            for (const key of Object.keys(breadcrumb.data)) {
              const lowerKey = key.toLowerCase()
              if (
                lowerKey.includes('token') ||
                lowerKey.includes('key') ||
                lowerKey.includes('secret') ||
                lowerKey.includes('password') ||
                lowerKey.includes('credential') ||
                lowerKey.includes('auth')
              ) {
                breadcrumb.data[key] = '[REDACTED]'
              }
            }
          }
        }
      }

      return event
    },
  },
  Sentry.init,
)

/**
 * 整个 React 树崩溃时展示的最小兜底 UI。
 * Sentry.ErrorBoundary 会自动捕获错误并上报到 Sentry。
 */
function CrashFallback() {
  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium">{i18n.t('crash.somethingWentWrong')}</p>
      <p className="text-[13px]">{i18n.t('crash.restartPrompt')}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
      >
        {i18n.t('crash.reload')}
      </button>
    </div>
  )
}

/**
 * 根组件：读取当前 workspace ID 并注入主题，然后渲染 App。
 * App.tsx 内部再判断当前是主窗口还是标签页窗口（main vs tab-content）。
 */
function Root() {
  // 共享 atom：App 在初始化和切换 workspace 时写入，这里读取以同步 ThemeProvider。
  // useAtomValue 只读，组件会在 atom 变化时重渲染。
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId}>
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

// `document.getElementById('root')!` 中的 `!` 是 TS 非空断言：告诉编译器这里一定不是 null。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashFallback />}>
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>
)
