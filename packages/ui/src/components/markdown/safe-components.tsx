/**
 * react-markdown 的安全组件处理
 *
 * 当用户输入类似 HTML 的内容（如 `<sq+qr>`）时，rehype-raw 会将其
 * 解释为 HTML 标签。如果标签名包含非法字符，React 会崩溃。
 * 本模块提供工具来优雅处理此类情况。
 */

import React from 'react'
import type { Components } from 'react-markdown'

/**
 * UnknownTag - 非法类 HTML 标签的兜底组件
 *
 * 将名称非法（包含 +、@ 等）的标签渲染为纯文本，而非使 React 崩溃。
 * 始终渲染开闭标签以保持一致性（反正是转义文本）。
 */
export const UnknownTag: React.FC<{ tagName: string; children?: React.ReactNode }> = ({
  tagName,
  children,
}) => (
  <span className="text-muted-foreground">
    {`<${tagName}>`}
    {children}
    {`</${tagName}>`}
  </span>
)

/** 匹配合法的小写 HTML 标签：div、span、h1 等 */
const VALID_HTML_TAG = /^[a-z][a-z0-9]*$/

/** 匹配合法的 PascalCase React 组件名：MyComponent、Button 等 */
const VALID_COMPONENT_NAME = /^[A-Z][a-zA-Z0-9_]*$/

/**
 * 检查标签名是否可用于 React/HTML 渲染。
 * 非法标签包含 +、@、-、空格等字符。
 */
export function isValidTagName(tagName: string): boolean {
  return VALID_HTML_TAG.test(tagName) || VALID_COMPONENT_NAME.test(tagName)
}

/**
 * 判断标签是否应使用兜底组件。
 * 对于未在 components 中显式定义的非法标签返回 true。
 */
function shouldUseFallback(prop: string | symbol, target: object): boolean {
  if (typeof prop === 'symbol') return false
  if (prop in target) return false
  return !isValidTagName(prop)
}

/** 为非法标签返回的描述符，使 hasOwnProperty 返回 true */
const INVALID_TAG_DESCRIPTOR: PropertyDescriptor = {
  configurable: true,
  enumerable: true,
  value: undefined, // 实际值来自 `get` 陷阱
  writable: true,
}

/**
 * 用 Proxy 包装 components 对象，以处理未知/非法标签名。
 *
 * 返回：
 * - 若在 components 映射中已定义，则返回原始组件
 * - 对于合法的 HTML/React 标签名，返回 undefined（交给 React 处理）
 * - 对于非法标签名（包含 +、@ 等），返回 UnknownTag 兜底组件
 *
 * @example
 * const safeComponents = wrapWithSafeProxy(components)
 * // <div> → 由 React 处理（合法 HTML）
 * // <MyComponent> → 由 React 处理（合法组件名）
 * // <sq+qr> → 由 UnknownTag 渲染为文本
 */
export function wrapWithSafeProxy(components: Partial<Components>): Partial<Components> {
  const fallbackCache = new Map<string, React.FC<{ children?: React.ReactNode }>>()

  return new Proxy(components, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (prop in target) return target[prop as keyof typeof target]
      if (!shouldUseFallback(prop, target)) return undefined

      if (!fallbackCache.has(prop)) {
        const Fallback: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
          <UnknownTag tagName={prop}>{children}</UnknownTag>
        )
        Fallback.displayName = `UnknownTag(${prop})`
        fallbackCache.set(prop, Fallback)
      }
      return fallbackCache.get(prop)
    },

    has(target, prop) {
      if (typeof prop === 'symbol') return Reflect.has(target, prop)
      return prop in target || shouldUseFallback(prop, target)
    },

    // 关键：hast-util-to-jsx-runtime 使用 Object.hasOwnProperty 来检查
    // 组件，它调用的是 getOwnPropertyDescriptor，而非 `has` 陷阱。
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'symbol') return Reflect.getOwnPropertyDescriptor(target, prop)

      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      if (descriptor) return descriptor

      return shouldUseFallback(prop, target) ? INVALID_TAG_DESCRIPTOR : undefined
    },
  })
}
