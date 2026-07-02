/**
 * 自动化状态原子
 *
 * 存储已解析的工作区自动化配置（automations）的 Jotai atom。
 * AppShell 从工作区根目录加载 automations.json 后会填充此 atom。
 * MainContentPanel 读取该 atom 用于展示自动化详情。
 *
 * Jotai atom 类似 React 的 useState/useContext，但可以在组件树外共享状态。
 * Electron renderer（渲染进程）里的这些 atom 就是前端的全局状态。
 */

import { atom } from 'jotai'
import type { AutomationListItem } from '../components/automations/types'

/**
 * 当前工作区已解析的自动化列表。
 * AppShell 加载 automations.json 并通过 parseAutomationsConfig() 解析后，会 set 这个 atom。
 */
export const automationsAtom = atom<AutomationListItem[]>([])
