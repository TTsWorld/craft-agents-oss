/**
 * StructuredInput - 结构化输入路由组件。
 *
 * 根据输入类型分发到对应的具体组件：
 * - permission：PermissionRequest（bash 命令审批）
 * - credential：CredentialRequest（安全认证输入）
 * - admin_approval：AdminApprovalRequest（管理员权限审批）
 */
import type { PermissionRequest as PermissionRequestType, CredentialRequest as CredentialRequestType } from '../../../../shared/types'
import { PermissionRequest } from './structured/PermissionRequest'
import { CredentialRequest } from './structured/CredentialRequest'
import { AdminApprovalRequest } from './structured/AdminApprovalRequest'
import type { StructuredInputState, StructuredResponse } from './structured/types'

interface StructuredInputProps {
  state: StructuredInputState
  onResponse: (response: StructuredResponse) => void
  /** 为 true 时移除容器样式（阴影、背景、圆角），用于被 InputContainer 包裹时 */
  unstyled?: boolean
}

/**
 * StructuredInput - 结构化输入 UI 的路由组件。
 *
 * 根据类型分发到具体组件。
 */
export function StructuredInput({ state, onResponse, unstyled = false }: StructuredInputProps) {
  switch (state.type) {
    case 'permission':
      return (
        <PermissionRequest
          request={state.data as PermissionRequestType}
          onResponse={onResponse}
          unstyled={unstyled}
        />
      )
    case 'credential':
      return (
        <CredentialRequest
          request={state.data as CredentialRequestType}
          onResponse={onResponse}
          unstyled={unstyled}
        />
      )
    case 'admin_approval':
      return (
        <AdminApprovalRequest
          request={state.data as import('./structured/AdminApprovalRequest').AdminApprovalRequestData}
          onApprove={({ rememberForMinutes }) => onResponse({ type: 'admin_approval', approved: true, rememberForMinutes })}
          onCancel={() => onResponse({ type: 'admin_approval', approved: false })}
          unstyled={unstyled}
        />
      )
    default:
      return null
  }
}
