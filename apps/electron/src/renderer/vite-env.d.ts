/**
 * Vite 客户端类型声明与静态资源模块类型扩展。
 *
 * 让 TypeScript 认识 `*.png`、`*.svg`、`*.pdf?url` 等导入，
 * 并通过 `/// <reference types="vite/client" />` 获得 Vite 客户端环境类型。
 */
/// <reference types="vite/client" />

// 图片资源导入声明
declare module "*.png" {
  const src: string
  export default src
}

declare module "*.jpg" {
  const src: string
  export default src
}

declare module "*.jpeg" {
  const src: string
  export default src
}

declare module "*.svg" {
  const src: string
  export default src
}

// PDF 资源导入声明（配合 ?url suffix，给 react-pdf 使用）
declare module "*.pdf?url" {
  const src: string
  export default src
}
