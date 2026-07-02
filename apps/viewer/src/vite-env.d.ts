/// <reference types="vite/client" />

/**
 * Vite 客户端类型声明文件。
 *
 * 这里用 `declare module` 告诉 TypeScript：某些带 `?url` 后缀的资源导入会返回字符串。
 * 类似 Go 里给外部库写类型断言，让编译器知道返回值形状。
 */

declare module '*.mjs?url' {
  const src: string
  export default src
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const workerUrl: string
  export default workerUrl
}
