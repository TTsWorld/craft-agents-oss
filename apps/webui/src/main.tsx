import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import App from './App'
import { ThemeProvider } from '@/context/ThemeContext'
import { windowWorkspaceIdAtom } from '@/atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { useTranslation } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import './index.css'

// 在任何 React 组件渲染前先初始化 i18n 国际化
setupI18n([LanguageDetector, initReactI18next])

// 崩溃兜底组件：当 Suspense fallback 或主应用出错时显示
function CrashFallback() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium">{t("auth.somethingWentWrong")}</p>
      <p className="text-[13px]">{t("errors.pleaseReload")}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
      >
        {t("common.reload")}
      </button>
    </div>
  )
}

// ErrorBoundary：用 React.Suspense 包裹子组件，加载中/异常时显示 CrashFallback
function ErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense fallback={<CrashFallback />}>
      {children}
    </React.Suspense>
  )
}

// Root：读取当前窗口的 workspace ID，并注入主题上下文
function Root() {
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId}>
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

// 挂载根组件到 DOM 的 #root 节点
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
