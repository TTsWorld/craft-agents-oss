/**
 * FileViewer 组件
 *
 * 这是一个 React 函数组件（可以理解为接收 props 并返回 UI 的纯函数），
 * 运行在 Electron 的 renderer 进程（即前端界面进程）中。
 * 功能：根据传入的文件路径，调用 Electron 主进程通过 preload 暴露的 API 读取文件内容并展示。
 */
import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FileText } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'

/** 组件的 props 类型声明，相当于给函数参数定义一个结构体。 */
interface FileViewerProps {
  /** 要查看的文件绝对路径；为 null 时表示还没有选择文件。 */
  path: string | null
}

/** FileViewer：渲染单个文件内容的查看器组件。 */
export function FileViewer({ path }: FileViewerProps) {
  // useTranslation 是 react-i18next 提供的 hook，用于获取多语言翻译函数 t。
  const { t } = useTranslation()

  // useState<T>() 是 React 的状态 hook，返回 [当前值, 设置函数]。
  // 可以理解为 Golang 中的一个变量和它的 setter：调用 setter 会触发组件重新渲染。
  const [content, setContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * useEffect 是 React 的副作用 hook。
   * 当依赖数组中的 path 变化时，会重新执行里面的逻辑。
   * 这里用来异步加载文件内容：类似 Golang 里启动一个 goroutine 调用函数并更新共享状态。
   */
  useEffect(() => {
    if (!path) {
      setContent('')
      setError(null)
      return
    }

    const loadFile = async () => {
      setIsLoading(true)
      setError(null)
      try {
        // window.electronAPI 是 Electron preload 脚本注入到 renderer 窗口的 API 对象，
        // 用于安全地调用主进程能力（这里是读取本地文件）。
        const fileContent = await window.electronAPI.readFile(path)
        setContent(fileContent)
      } catch (err) {
        // 捕获异常并把错误信息存入状态；如果 err 不是 Error 实例则使用兜底文案。
        setError(err instanceof Error ? err.message : 'Failed to load file')
        setContent('')
      } finally {
        setIsLoading(false)
      }
    }

    loadFile()
  }, [path])

  // 未选择文件时的占位提示
  if (!path) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8 text-center">
        <div className="size-16 bg-muted rounded-2xl flex items-center justify-center mb-4">
          <FileText className="size-8 text-muted-foreground/50" />
        </div>
        <p className="font-medium text-foreground">{t("fileViewer.noFileSelected")}</p>
        <p className="text-sm mt-1">{t("fileViewer.clickToView")}</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* 文件路径头部 */}
      <div className="px-4 py-3 bg-muted/50 border-b flex items-center gap-2 shrink-0">
        <FileText className="size-4 text-muted-foreground shrink-0" />
        <p className="text-xs font-mono text-muted-foreground truncate select-all" title={path}>
          {path}
        </p>
      </div>

      {/* 文件内容区域 */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground gap-3">
              <Spinner className="text-lg" />
              <span className="text-sm font-medium">{t("fileViewer.loadingContent")}</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-32 text-destructive gap-2">
              <p className="text-sm font-medium">{t("fileViewer.errorLoading")}</p>
              <p className="text-xs">{error}</p>
            </div>
          ) : (
            <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed selection:bg-foreground/20">
              {content}
            </pre>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
