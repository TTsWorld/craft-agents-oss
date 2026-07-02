/**
 * structured/types.ts - 结构化输入相关类型定义。
 *
 * 这些类型用于在 InputContainer 中决定渲染自由输入还是结构化输入，
 * 以及描述结构化输入的数据与响应形状。
 */
import type { PermissionRequest, CredentialRequest, CredentialResponse } from '../../../../../shared/types'
import type { AdminApprovalRequestData } from './AdminApprovalRequest'

/** 输入模式：决定 InputContainer 渲染自由输入还是结构化输入 */
export type InputMode = 'freeform' | 'structured'

/** 结构化输入 UI 的类型 */
export type StructuredInputType = 'permission' | 'credential' | 'admin_approval'

/** 结构化输入数据的联合类型 */
export type StructuredInputData =
  | { type: 'permission'; data: PermissionRequest }
  | { type: 'credential'; data: CredentialRequest }
  | { type: 'admin_approval'; data: AdminApprovalRequestData }

/** 结构化输入状态 */
export interface StructuredInputState {
  type: StructuredInputType
  data: PermissionRequest | CredentialRequest | AdminApprovalRequestData
}

/** 权限请求的响应 */
export interface PermissionResponse {
  type: 'permission'
  allowed: boolean
  alwaysAllow: boolean
}

/** 管理员审批请求的响应 */
export interface AdminApprovalResponse {
  type: 'admin_approval'
  approved: boolean
  rememberForMinutes?: number
}

/** 所有结构化响应的联合类型 */
export type StructuredResponse = PermissionResponse | CredentialResponse | AdminApprovalResponse

// 为方便使用重新导出 CredentialResponse
export type { CredentialResponse }
