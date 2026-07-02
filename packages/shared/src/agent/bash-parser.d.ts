/**
 * Type declarations for bash-parser
 *
 * `bash-parser` 是一个把 bash 脚本解析成 AST 的 JS 库。库本身没有自带类型定义，
 * 所以这里手写一个最小可用的 ambient module 声明；详细的 AST 节点类型在
 * bash-validator.ts 内自定义。
 *
 * @see https://github.com/vorpaljs/bash-parser
 */

declare module 'bash-parser' {
  /**
   * 把 bash 命令字符串解析为 AST。
   *
   * 我们在 bash-validator.ts 里定义并使用以下 AST 节点类型：
   * - Script: 顶层节点，含 commands 数组
   * - Command: 简单命令，包含 name 和 suffix（参数）
   * - LogicalExpression: && 或 || 链
   * - Pipeline: 管道（|）串联的多条命令
   * - Subshell: 括号包裹的子 shell（...）
   * - CompoundList: 子 shell 等内部的命令列表
   * - Redirect: 文件重定向（>, >>, <）
   * - Word: 文本 token，可能带 expansion
   *
   * @param command - 待解析的 bash 命令字符串
   * @returns AST 根节点（Script 类型）；为简单起见这里返回 unknown，
   *          调用方负责断言为具体节点类型。
   */
  function bashParser(command: string): unknown;
  export default bashParser;
}
