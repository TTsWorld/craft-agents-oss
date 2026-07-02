/**
 * Playground 组件注册表入口。
 *
 * 把所有子注册表（chat、turn-card、onboarding 等）合并成一个扁平列表，
 * 并暴露按分类排序的查询方法。可以把它理解为 Go 中一个聚合多个子包的 "registry" 包。
 */

import type { ComponentEntry, CategoryGroup, Category } from './types'
import { onboardingComponents } from './onboarding'
import { chatComponents } from './chat'
import { turnCardComponents, fullscreenOverlayComponents } from './turn-card'
import { turnCardModesComponents } from './turn-card-modes'
import { messagesComponents } from './messages'
import { inputComponents } from './input'
import { slashCommandComponents } from './slash-command'
import { markdownComponents } from './markdown'
import { iconComponents } from './icons'
import { oauthComponents } from './oauth'
import { toastsComponents } from './toasts'
import { sessionListComponents } from './session-list'
import { projectColorsComponents } from './project-colors'
import { editPopoverComponents } from './edit-popover'
import { automationComponents } from './automations'
import { entityListComponents } from './entity-lists'
import { browserUiComponents } from './browser-ui'
import { plannerComponents } from './planner'
import { customShadowsComponents } from './custom-shadows'
import { transportBannerComponents } from './transport-banner'
import { containerTransitionsComponents } from './container-transitions'
import { apiKeyInputComponents } from './api-key-input'
import { messagingComponents } from './messaging'
import { imageSupportComponents } from './image-support'
import { mobileWebUIComponents } from './mobile-webui'
import { kanbanComponents } from './kanban'
import { taskEditorComponents } from './task-editor'

export * from './types'

/** 所有 playground 组件的扁平注册表 */
export const componentRegistry: ComponentEntry[] = [
  ...mobileWebUIComponents,
  ...apiKeyInputComponents,
  ...onboardingComponents,
  ...chatComponents,
  ...turnCardComponents,
  ...turnCardModesComponents,
  ...fullscreenOverlayComponents,
  ...messagesComponents,
  ...inputComponents,
  ...toastsComponents,
  ...slashCommandComponents,
  ...markdownComponents,
  ...iconComponents,
  ...oauthComponents,
  ...sessionListComponents,
  ...kanbanComponents,
  ...taskEditorComponents,
  ...projectColorsComponents,
  ...editPopoverComponents,
  ...automationComponents,
  ...entityListComponents,
  ...browserUiComponents,
  ...plannerComponents,
  ...customShadowsComponents,
  ...transportBannerComponents,
  ...containerTransitionsComponents,
  ...messagingComponents,
  ...imageSupportComponents,
]

/**
 * 返回按固定分类顺序排好的组件分组。
 *
 * 不在 categoryOrder 里的分类会被过滤掉，这样 Sidebar 只展示我们关心的分组。
 */
export function getCategories(): CategoryGroup[] {
  const categoryOrder: Category[] = ['Mobile WebUI', 'Automations', 'Onboarding', 'Agent Setup', 'Chat', 'Island', 'Browser', 'Planner', 'Custom Shadows', 'Session List', 'Kanban', 'Entity Lists', 'Edit Popover', 'Turn Cards', 'TurnCard Modes', 'Fullscreen', 'Chat Messages', 'Chat Inputs', 'Toast Messages', 'Markdown', 'Icons', 'OAuth', 'Messaging']
  const categoryMap = new Map<Category, ComponentEntry[]>()

  for (const entry of componentRegistry) {
    const existing = categoryMap.get(entry.category) ?? []
    categoryMap.set(entry.category, [...existing, entry])
  }

  return categoryOrder
    .filter(name => categoryMap.has(name))
    .map(name => ({
      name,
      components: categoryMap.get(name)!,
    }))
}

/** 按 id 查找组件 */
export function getComponentById(id: string): ComponentEntry | undefined {
  return componentRegistry.find(c => c.id === id)
}
