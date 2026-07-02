/**
 * input/index.ts - 输入区组件与 hooks 的聚合导出入口。
 *
 * 这里把输入容器、聊天输入区、自由输入、结构化输入等模块统一暴露出去，
 * 方便上层直接 import { InputContainer } from '@/components/app-shell/input'。
 */
// 主组件
export { InputContainer } from './InputContainer'
export { ChatInputZone } from './ChatInputZone'
export { FreeFormInput } from './FreeFormInput'
export { StructuredInput } from './StructuredInput'

// 结构化输入子组件
export { PermissionRequest } from './structured/PermissionRequest'

// 钩子（Hooks）
export { useAutoGrow } from './useAutoGrow'

// 类型
export type {
  InputMode,
  StructuredInputType,
  StructuredInputState,
  StructuredInputData,
  StructuredResponse,
  PermissionResponse,
  AdminApprovalResponse,
} from './structured/types'
