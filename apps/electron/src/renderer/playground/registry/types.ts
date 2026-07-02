import type { ComponentType, ReactNode } from 'react'

/** 右侧属性面板中控件类型：布尔、单行文本、多行文本、数字、下拉选择 */
export type ControlType =
  | { type: 'boolean' }
  | { type: 'string'; placeholder?: string }
  | { type: 'textarea'; placeholder?: string; rows?: number }
  | { type: 'number'; min?: number; max?: number; step?: number }
  | { type: 'select'; options: Array<{ label: string; value: string }> }

/** 单个可调试属性的定义 */
export interface PropDefinition {
  name: string
  description?: string
  control: ControlType
  defaultValue: unknown
}

/** 组件变体：一组预设 props，用于快速切换展示状态 */
export interface ComponentVariant {
  name: string
  description?: string
  props: Record<string, unknown>
}

/** Playground 左侧分类名称集合 */
export type Category = 'Sources' | 'Automations' | 'Mobile WebUI' | 'Onboarding' | 'Agent Setup' | 'Chat' | 'Island' | 'Browser' | 'Planner' | 'Custom Shadows' | 'Session List' | 'Kanban' | 'Entity Lists' | 'Edit Popover' | 'Turn Cards' | 'TurnCard Modes' | 'Fullscreen' | 'Chat Messages' | 'Chat Inputs' | 'Toast Messages' | 'Markdown' | 'Icons' | 'Settings' | 'Messaging' | 'Feedback' | 'OAuth'

/**
 * 单个组件在注册表中的描述。
 *
 * TS 提示：`ComponentType<any>` 用于兼容各种 React 组件签名；
 * 实际渲染时会通过 props / mockData 把数据注入进去。
 */
export interface ComponentEntry {
  id: string
  name: string
  category: Category
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>
  props: PropDefinition[]
  variants?: ComponentVariant[]
  /** 返回 mock 数据并与 props 合并（常用于回调、复杂对象） */
  mockData?: () => Record<string, unknown>
  /** 可选的 wrapper 组件，用于包裹 Context Provider */
  wrapper?: ComponentType<{ children: ReactNode }>
  /** 布局模式：centered（默认居中）、top（顶部对齐可滚动）、full（占满 flex 高度） */
  layout?: 'centered' | 'top' | 'full'
  /** 预览框 overflow 行为覆盖 */
  previewOverflow?: 'auto' | 'hidden' | 'visible'
}

/** 分类分组 */
export interface CategoryGroup {
  name: Category
  components: ComponentEntry[]
}
