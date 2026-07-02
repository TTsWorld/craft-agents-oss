/**
 * 技能状态原子
 *
 * 存储工作区技能（skills）的简单 Jotai atom。
 * NavigationContext 在导航到 skills 视图时用它做自动选择。
 */

import { atom } from 'jotai'
import type { LoadedSkill } from '../../shared/types'

/**
 * 当前工作区的技能列表。
 * AppShell 加载 skills 后填充此 atom。
 * NavigationContext 读取它用于自动选中某项。
 */
export const skillsAtom = atom<LoadedSkill[]>([])
