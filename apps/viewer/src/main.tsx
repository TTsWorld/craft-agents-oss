/**
 * Viewer 应用的入口文件。
 *
 * 负责初始化国际化（i18n）并把根组件 App 挂载到 DOM 中的 #root 节点。
 * 类似 Go 的 main() 函数：先做好依赖准备，再启动程序。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import './index.css'

// 在渲染任何 React 组件之前先初始化国际化配置
setupI18n([initReactI18next])

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
