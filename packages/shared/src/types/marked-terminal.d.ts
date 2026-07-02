/**
 * marked-terminal 的类型声明文件（.d.ts）。
 *
 * 作用：为没有自带 TypeScript 类型的第三方 npm 包补充类型信息，
 * 让 TS 编译器知道该模块的导出、参数和返回值形状。
 *
 * 类比 Go：类似于给没有源码的第三方库手写 interface/类型别名。
 */
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  /**
   * marked-terminal 的渲染配置选项。
   *
   * `interface` 在 TS 里定义对象形状，类似 Go 的 interface；
   * 字段后面的 `?` 表示可选字段，类似 Go struct tag 里的 omitempty。
   */
  interface MarkedTerminalOptions {
    // 各个 Markdown 元素的自定义渲染函数
    code?: (code: string) => string;                                 // 代码块
    blockquote?: (quote: string) => string;                          // 引用块
    html?: (html: string) => string;                                 // 原始 HTML
    heading?: (text: string) => string;                              // 标题
    firstHeading?: (text: string) => string;                         // 文档第一个标题
    hr?: () => string;                                               // 水平分割线
    listitem?: (text: string) => string;                             // 列表项
    list?: (body: string, ordered: boolean) => string;               // 有序/无序列表
    table?: (header: string, body: string) => string;                // 表格
    paragraph?: (text: string) => string;                            // 段落
    strong?: (text: string) => string;                               // 粗体
    em?: (text: string) => string;                                   // 斜体
    codespan?: (code: string) => string;                             // 行内代码
    del?: (text: string) => string;                                  // 删除线
    link?: (href: string, title: string, text: string) => string;    // 链接
    href?: (href: string) => string;                                 // 链接地址

    // 格式控制开关
    showSectionPrefix?: boolean; // 是否显示章节前缀
    unescape?: boolean;          // 是否反转义 HTML 实体
    width?: number;              // 终端输出宽度
    reflowText?: boolean;        // 是否根据宽度重排文本
    tab?: number;                // Tab 缩进空格数
    emoji?: boolean;             // 是否渲染 emoji
  }

  /**
   * 将 marked-terminal 渲染器注册为 marked 扩展。
   *
   * @param options - 渲染配置（可选）
   * @returns marked 的扩展对象，可直接传给 marked.use()
   */
  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
