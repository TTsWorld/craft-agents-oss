// 无类型定义依赖的 ambient 模块声明。
// 仅用于 typecheck 配置；bun 运行时的模块解析能正常处理这些依赖。
declare module 'turndown';
declare module 'pdfjs-dist/build/pdf.mjs';
declare module 'pdfjs-dist/build/pdf.worker.mjs';
declare module 'bash-parser';
