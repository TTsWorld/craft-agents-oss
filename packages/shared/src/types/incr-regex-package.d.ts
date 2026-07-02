/**
 * incr-regex-package 的类型声明文件（.d.ts）。
 *
 * 该库提供“增量正则匹配”能力：可以逐字符输入并判断匹配在“哪里”失败，
 * 常用于生成更智能的错误提示。
 *
 * @see https://github.com/nurulc/incr-regex-package
 */
declare module 'incr-regex-package' {
  /** 匹配状态：已完全匹配成功 */
  export const DONE: symbol;

  /** 匹配状态：目前有效，但还需要更多字符 */
  export const MORE: symbol;

  /** 匹配状态：当前是个合法结束点，但继续输入可能扩展匹配 */
  export const MAYBE: symbol;

  /** 匹配状态：输入非法，匹配失败 */
  export const FAILED: symbol;

  /**
   * 增量正则匹配器 IREGEX。
   * 支持逐字符处理输入，精确找出匹配失败的断点。
   *
   * @example
   * const rx = new IREGEX("^git\\s+(status|log|diff)");
   * const [success, count, matched] = rx.matchStr("git -C /path status");
   * // 返回 [false, 4, "git "] —— 在 "-C" 之前匹配了 4 个字符后失败
   */
  export class IREGEX {
    /**
     * 创建一个新的增量正则匹配器。
     * @param pattern - 字符串形式的正则表达式
     */
    constructor(pattern: string);

    /**
     * 处理单个字符。
     * @param char - 要匹配的单个字符
     * @returns 该字符是否被接受；true 表示接受，false 表示拒绝
     */
    match(char: string): boolean;

    /**
     * 一次性处理整个字符串。
     * @param str - 要匹配的字符串
     * @returns 三元组 [success, charCount, matchedString]
     *   - success：整个字符串是否完全匹配
     *   - charCount：失败前成功匹配的字符数
     *   - matchedString：实际匹配到的子串
     */
    matchStr(str: string): [boolean, number, string];

    /**
     * 获取当前匹配状态。
     * @returns DONE、MORE、MAYBE、FAILED 之一
     */
    state(): symbol;

    /**
     * 获取当前必需输入的最小掩码字符串。
     * 可变位置用下划线 `_` 占位。
     * @returns 表示所需格式的掩码字符串，例如电话号码的 "___-___-____"
     */
    minChars(): string;

    /**
     * 将匹配器重置为初始状态。
     */
    reset(): void;

    /**
     * 创建一个独立的匹配器副本。
     * @returns 与原匹配器使用相同模式的新 IREGEX 实例
     */
    clone(): IREGEX;

    /**
     * 创建一个独立的匹配器副本（clone 的别名）。
     * @returns 与原匹配器使用相同模式的新 IREGEX 实例
     */
    copy(): IREGEX;
  }
}
