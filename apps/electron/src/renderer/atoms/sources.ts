/**
 * 来源状态原子
 *
 * 存储工作区来源（sources）的简单 Jotai atom。
 * NavigationContext 在导航到 sources 视图时用它做自动选择。
 */

import { atom } from 'jotai'
import type { LoadedSource } from '../../shared/types'

/**
 * 当前工作区的来源列表。
 * AppShell 加载 sources 后填充此 atom。
 * NavigationContext 读取它用于自动选中某项。
 */
export const sourcesAtom = atom<LoadedSource[]>([])
