/**
 * useWorkspaceIcon Hook
 *
 * 获取工作区图标并转为可在 <img> 中渲染的 URL。
 * 由于 Electron 的 CSP 会阻止 renderer 直接使用 file:// URL，
 * 因此通过 IPC 把 file:// 转为 data URL。
 *
 * 用于设置页面展示工作区图标。
 */

import { useState, useEffect, useRef } from 'react'
import type { Workspace } from '../../shared/types'

// 模块级缓存，避免多个组件实例重复请求
// key: workspaceId, value: { dataUrl, sourceUrl }
const iconCache = new Map<string, { dataUrl: string; sourceUrl: string }>()

/**
 * 获取单个工作区图标的可渲染 URL。
 *
 * - 远程 URL（http/https）直接返回
 * - 本地 file:// URL 通过 IPC 转为 data URL
 * - 加载中或没有图标时返回 undefined
 *
 * @param workspace - 带 iconUrl 的 workspace 对象
 * @returns 图标的数据 URL 或远程 URL，没有则 undefined
 */
export function useWorkspaceIcon(workspace: Workspace | undefined): string | undefined {
  const [iconUrl, setIconUrl] = useState<string | undefined>(() => {
    if (!workspace?.iconUrl) return undefined

    // 远程 URL 可直接使用
    if (workspace.iconUrl.startsWith('http://') || workspace.iconUrl.startsWith('https://')) {
      return workspace.iconUrl
    }

    // 检查 file:// URL 是否已缓存
    const cached = iconCache.get(workspace.id)
    if (cached && cached.sourceUrl === workspace.iconUrl) {
      return cached.dataUrl
    }

    return undefined
  })

  // 跟踪 workspace 以便检测变化
  const workspaceRef = useRef(workspace)

  useEffect(() => {
    if (!workspace?.iconUrl) {
      setIconUrl(undefined)
      return
    }

    // 远程 URL 直接使用
    if (workspace.iconUrl.startsWith('http://') || workspace.iconUrl.startsWith('https://')) {
      setIconUrl(workspace.iconUrl)
      return
    }

    // 非 file:// URL 跳过
    if (!workspace.iconUrl.startsWith('file://')) {
      setIconUrl(undefined)
      return
    }

    // 若缓存命中且源 URL 未变，直接复用
    const cached = iconCache.get(workspace.id)
    if (cached && cached.sourceUrl === workspace.iconUrl) {
      setIconUrl(cached.dataUrl)
      return
    }

    // 从 file:// URL 中提取图标文件名
    // 例如 "file:///path/to/icon.png?t=123" -> "icon.png"
    const urlWithoutQuery = workspace.iconUrl.split('?')[0]
    const iconFilename = urlWithoutQuery.split('/').pop()
    if (!iconFilename) {
      setIconUrl(undefined)
      return
    }

    // 通过 IPC 读取并转为 data URL
    let cancelled = false

    async function fetchIcon() {
      try {
        const result = await window.electronAPI.readWorkspaceImage(workspace!.id, iconFilename!)
        if (cancelled) return

        if (result) {
          // .svg 返回原始 SVG 字符串，其他格式返回 data URL
          let dataUrl = result
          if (iconFilename!.endsWith('.svg')) {
            dataUrl = `data:image/svg+xml;base64,${btoa(result)}`
          }

          // 缓存结果
          iconCache.set(workspace!.id, { dataUrl, sourceUrl: workspace!.iconUrl! })
          setIconUrl(dataUrl)
        } else {
          setIconUrl(undefined)
        }
      } catch (error) {
        console.error(`Failed to load icon for workspace ${workspace!.id}:`, error)
        if (!cancelled) {
          setIconUrl(undefined)
        }
      }
    }

    fetchIcon()

    return () => {
      cancelled = true
    }
  }, [workspace?.id, workspace?.iconUrl])

  return iconUrl
}

/**
 * 批量获取多个工作区的图标。
 * 比每个 workspace 单独调用 useWorkspaceIcon 更高效。
 *
 * @param workspaces - workspace 对象数组
 * @returns workspaceId -> 图标 URL（data URL 或远程 URL）的 Map
 */
export function useWorkspaceIcons(workspaces: Workspace[]): Map<string, string> {
  const [iconMap, setIconMap] = useState<Map<string, string>>(() => {
    const map = new Map<string, string>()
    for (const ws of workspaces) {
      if (!ws.iconUrl) continue

      // 远程 URL
      if (ws.iconUrl.startsWith('http://') || ws.iconUrl.startsWith('https://')) {
        map.set(ws.id, ws.iconUrl)
        continue
      }

      // 已缓存的 file:// URL
      const cached = iconCache.get(ws.id)
      if (cached && cached.sourceUrl === ws.iconUrl) {
        map.set(ws.id, cached.dataUrl)
      }
    }
    return map
  })

  useEffect(() => {
    let cancelled = false

    async function fetchIcons() {
      const newMap = new Map<string, string>()

      for (const workspace of workspaces) {
        if (!workspace.iconUrl) continue

        // 远程 URL 直接使用
        if (workspace.iconUrl.startsWith('http://') || workspace.iconUrl.startsWith('https://')) {
          newMap.set(workspace.id, workspace.iconUrl)
          continue
        }

        // 非 file:// URL 跳过
        if (!workspace.iconUrl.startsWith('file://')) continue

        // 优先查缓存
        const cached = iconCache.get(workspace.id)
        if (cached && cached.sourceUrl === workspace.iconUrl) {
          newMap.set(workspace.id, cached.dataUrl)
          continue
        }

        // 提取图标文件名
        const urlWithoutQuery = workspace.iconUrl.split('?')[0]
        const iconFilename = urlWithoutQuery.split('/').pop()
        if (!iconFilename) continue

        try {
          const result = await window.electronAPI.readWorkspaceImage(workspace.id, iconFilename)
          if (cancelled) return

          if (result) {
            let dataUrl = result
            if (iconFilename.endsWith('.svg')) {
              dataUrl = `data:image/svg+xml;base64,${btoa(result)}`
            }

            iconCache.set(workspace.id, { dataUrl, sourceUrl: workspace.iconUrl })
            newMap.set(workspace.id, dataUrl)
          }
        } catch (error) {
          console.error(`Failed to load icon for workspace ${workspace.id}:`, error)
        }
      }

      if (!cancelled) {
        setIconMap(newMap)
      }
    }

    fetchIcons()

    return () => {
      cancelled = true
    }
  }, [workspaces])

  return iconMap
}
