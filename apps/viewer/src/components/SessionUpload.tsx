/**
 * SessionUpload - 用于上传会话 JSON 文件的组件。
 *
 * 支持三种交互方式：
 * - 点击选择文件
 * - 拖拽上传
 * - 从剪贴板粘贴 JSON 文本
 *
 * 这里处理的是 Craft Agent 会话数据（StoredSession），
 * 可以理解为 Agent 运行后留下的“聊天记录/上下文快照”。
 */

import * as React from 'react'
import { useState, useCallback, useRef, useEffect } from 'react'
import type { StoredSession } from '@craft-agent/core'
import { Upload, FileJson, AlertCircle } from 'lucide-react'

/**
 * SessionUploadProps - 组件接收的属性。
 *
 * onSessionLoad 是回调函数，当文件解析成功后会话对象会被传回父组件。
 */
interface SessionUploadProps {
  onSessionLoad: (session: StoredSession) => void
}

export function SessionUpload({ onSessionLoad }: SessionUploadProps) {
  // 是否正在拖拽文件到上传区域上
  const [isDragging, setIsDragging] = useState(false)
  // 错误提示信息，null 表示没有错误
  const [error, setError] = useState<string | null>(null)
  // 隐藏的 <input type="file"> 的引用，用于通过点击触发文件选择框
  const fileInputRef = useRef<HTMLInputElement>(null)

  /**
   * 解析并验证单个会话文件。
   *
   * 1. 仅接受 .json 后缀。
   * 2. 读取文本后用 JSON.parse 反序列化。
   * 3. 简单校验是否包含 id 和 messages 数组。
   * 4. 通过 as StoredSession 进行类型断言（类似 Go 的类型强转但仅在编译期生效）。
   */
  const parseSessionFile = useCallback(async (file: File) => {
    setError(null)

    if (!file.name.endsWith('.json')) {
      setError('Please upload a JSON file')
      return
    }

    try {
      const text = await file.text()
      const data = JSON.parse(text)

      // 校验会话的基本结构：必须有 id 和 messages 数组
      if (!data.id || !data.messages || !Array.isArray(data.messages)) {
        setError('Invalid session format: missing id or messages array')
        return
      }

      onSessionLoad(data as StoredSession)
    } catch {
      setError('Failed to parse JSON file')
    }
  }, [onSessionLoad])

  /**
   * 拖拽进入/悬停时的处理。
   *
   * 必须调用 preventDefault()，否则浏览器默认会打开文件而不是交给网页处理。
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  // 拖拽离开上传区域时取消高亮
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  // 放下文件时取第一个文件并解析
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const file = e.dataTransfer.files[0]
    if (file) {
      parseSessionFile(file)
    }
  }, [parseSessionFile])

  // 通过 <input> 选择文件后触发解析
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      parseSessionFile(file)
    }
  }, [parseSessionFile])

  // 点击上传区域时主动触发隐藏的文件选择框
  const handleClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  /**
   * 监听剪贴板粘贴事件。
   *
   * 如果粘贴内容是合法 JSON，并且符合会话结构，就直接加载。
   * 不是 JSON 时静默忽略，避免打扰用户。
   */
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text')
      if (!text) return

      try {
        const data = JSON.parse(text)
        if (data.id && data.messages && Array.isArray(data.messages)) {
          onSessionLoad(data as StoredSession)
        }
      } catch {
        // 不是合法 JSON，忽略即可
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [onSessionLoad])

  return (
    <div className="w-full max-w-xl">
      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          drop-zone cursor-pointer rounded-lg border-2 border-dashed p-12
          flex flex-col items-center justify-center gap-4
          transition-all duration-200
          ${isDragging
            ? 'active border-accent bg-accent/5'
            : 'border-foreground/10 hover:border-foreground/20 hover:bg-foreground/3'
          }
        `}
      >
        <div className={`
          p-4 rounded-full
          ${isDragging ? 'bg-accent/10 text-accent' : 'bg-foreground/5 text-foreground/50'}
        `}>
          {isDragging ? (
            <FileJson className="w-8 h-8" />
          ) : (
            <Upload className="w-8 h-8" />
          )}
        </div>

        <div className="text-center">
          <p className="text-lg font-medium text-foreground">
            {isDragging ? 'Drop session file here' : 'Upload session JSON'}
          </p>
          <p className="mt-1 text-sm text-foreground/50">
            Drag and drop, click to browse, or paste from clipboard
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-6 text-center text-xs text-foreground/30">
        <p>Session files are processed locally in your browser.</p>
        <p>No data is uploaded to any server.</p>
      </div>
    </div>
  )
}
