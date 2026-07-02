/**
 * oauth 注册项
 *
 * 演示 OAuth 授权完成/失败后的回调页面。页面 HTML 由共享函数生成，
 * 这里用 iframe 沙箱预览 success / error 等状态，而不触发真实 OAuth 流程。
 */
import * as React from 'react'
import type { ComponentEntry } from './types'
import { generateCallbackPage, type AppType } from '@craft-agent/shared/auth/callback-page'

/**
 * 在沙箱 iframe 里渲染 OAuth 回调 HTML 的预览组件。
 * HTML 由真实 OAuth 流程里使用的同一个函数生成，因此可以预览 success/error 状态。
 */
function OAuthCallbackPreview({
  isSuccess,
  errorDetail,
  appType,
}: {
  isSuccess: boolean
  errorDetail?: string
  appType: AppType
}) {
  const html = React.useMemo(() => {
    return generateCallbackPage({
      title: isSuccess ? 'Authorization Complete' : 'Authorization Failed',
      isSuccess,
      errorDetail,
      appType,
    })
  }, [isSuccess, errorDetail, appType])

  return (
    <iframe
      srcDoc={html}
      sandbox="allow-scripts"
      className="w-full h-full border-0"
      title="OAuth Callback Preview"
    />
  )
}

/** oauth 组件注册列表。 */
export const oauthComponents: ComponentEntry[] = [
  {
    id: 'oauth-callback',
    name: 'OAuth Callback Page',
    category: 'OAuth',
    description: 'Page shown in browser after OAuth authorization redirect',
    component: OAuthCallbackPreview,
    layout: 'full',
    props: [
      {
        name: 'isSuccess',
        description: 'Whether authorization was successful',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'appType',
        description: 'App type (electron or terminal)',
        control: {
          type: 'select',
          options: [
            { label: 'Electron', value: 'electron' },
            { label: 'Terminal', value: 'terminal' },
          ],
        },
        defaultValue: 'electron',
      },
      {
        name: 'errorDetail',
        description: 'Error message (only shown when isSuccess is false)',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      // Success states
      {
        name: 'Success',
        props: { isSuccess: true, appType: 'electron' },
      },
      // Error states
      {
        name: 'Error - Access Denied',
        props: {
          isSuccess: false,
          appType: 'electron',
          errorDetail: 'The user denied the authorization request.',
        },
      },
      {
        name: 'Error - Invalid Scope',
        props: {
          isSuccess: false,
          appType: 'electron',
          errorDetail: 'The requested scope is invalid or unknown.',
        },
      },
      {
        name: 'Error - Server Error',
        props: {
          isSuccess: false,
          appType: 'electron',
          errorDetail: 'The authorization server encountered an unexpected condition.',
        },
      },
      {
        name: 'Error - Expired Token',
        props: {
          isSuccess: false,
          appType: 'electron',
          errorDetail: 'The authorization code has expired.',
        },
      },
      {
        name: 'Error - Generic',
        props: {
          isSuccess: false,
          appType: 'electron',
        },
      },
    ],
    mockData: () => ({
      isSuccess: true,
      appType: 'electron',
    }),
  },
]
