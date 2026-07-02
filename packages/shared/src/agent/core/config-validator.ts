/**
 * ConfigValidator - 配置写前校验器
 *
 * 【中文学习注释 - 文件级】
 * 本文件是 Agent 核心的“配置写前校验器”。LLM 用 Write/Edit 工具修改配置文件时，
 * 如果内容格式错误（如 JSON 少了个逗号），可能导致整个应用无法启动。这个类在真正落盘前拦截错误。
 *
 * 核心职责：
 * 1. 根据文件路径/后缀识别配置类型（json / toml / yaml）。
 * 2. 识别是否为 Craft Agent 自身的配置文件（.craft-agent/...）。
 * 3. validateContent 按类型调用对应校验函数；JSON 用 JSON.parse，TOML/YAML 做基础语法检查。
 * 4. formatErrors 把校验结果格式化成人类可读文本，返回给 LLM/用户。
 *
 * 与 Golang 类比：很像一个输入校验中间件，return (valid bool, errors []string)。
 * TypeScript 注意点：
 * - ConfigValidationResult 使用 interface 描述返回结构，比 Golang 的命名返回值更清晰。
 * - private 方法 getLineColumn 只在类内部使用，类似 Golang 的小写未导出函数。
 */

import type { ConfigValidationResult, ConfigFileType, ConfigValidatorConfig } from './types.ts';

/**
 * 已知配置文件类型的匹配规则表。
 * 数组元素是 `{ pattern: RegExp; type: ConfigFileType }` 的对象字面量类型——
 * TS 在变量后用 `[]` 注解，表示这是一个元素为该对象类型的数组。
 * `i` 标志表示大小写不敏感。
 */
const CONFIG_FILE_PATTERNS: { pattern: RegExp; type: ConfigFileType }[] = [
  // JSON 配置
  { pattern: /\.json$/i, type: 'json' },
  { pattern: /\.jsonc$/i, type: 'json' }, // jsonc：带注释的 JSON
  // TOML 配置
  { pattern: /\.toml$/i, type: 'toml' },
  // YAML 配置（同时匹配 .yaml 和 .yml，`?` 表示前一个字符可选）
  { pattern: /\.ya?ml$/i, type: 'yaml' },
];

/**
 * Craft Agent 自身的配置文件路径正则集合（这些文件有明确的 schema，校验更严格）。
 */
const CRAFT_AGENT_CONFIG_PATTERNS = [
  // 主配置
  /\.craft-agent\/config\.json$/,
  // 偏好设置
  /\.craft-agent\/preferences\.json$/,
  // Source 配置
  /\.craft-agent\/workspaces\/[^/]+\/sources\/[^/]+\/config\.json$/,
  // 权限配置
  /\.craft-agent\/workspaces\/[^/]+\/permissions\.json$/,
  /\.craft-agent\/permissions\/[^/]+\.json$/,
  // 主题
  /\.craft-agent\/workspaces\/[^/]+\/theme\.json$/,
  // 状态
  /\.craft-agent\/workspaces\/[^/]+\/statuses\/config\.json$/,
  // 标签
  /\.craft-agent\/workspaces\/[^/]+\/labels\.json$/,
  // 工具图标
  /\.craft-agent\/tool-icons\/tool-icons\.json$/,
];

/**
 * ConfigValidator - 配置写前校验器。
 *
 * 用法示例：
 * ```typescript
 * const validator = new ConfigValidator();
 *
 * // 写入前先判断文件类型
 * const fileType = validator.getConfigType('/path/to/config.json');
 *
 * // 写入前校验内容
 * const result = validator.validateContent('/path/to/config.json', newContent);
 * if (!result.valid) {
 *   // 把错误展示给用户/agent
 * }
 * ```
 */
export class ConfigValidator {
  // 持有可选的配置项（当前主要为预留扩展点）
  private config: ConfigValidatorConfig;

  constructor(config: ConfigValidatorConfig = {}) {
    this.config = config;
  }

  // ============================================================
  // 配置类型探测
  // ============================================================

  /**
   * 根据文件路径/后缀探测配置文件类型。
   *
   * 注意：Windows 下会把路径统一为小写并改用正斜杠，便于跨平台比较。
   *
   * @param filePath - 文件路径
   * @returns 配置类型；若非已知配置格式则返回 null
   */
  getConfigType(filePath: string): ConfigFileType {
    const normalizedPath = process.platform === 'win32'
      ? filePath.replace(/\\/g, '/').toLowerCase()
      : filePath.replace(/\\/g, '/');

    for (const { pattern, type } of CONFIG_FILE_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        return type;
      }
    }

    return null;
  }

  /**
   * 判断文件路径是否属于 Craft Agent 自身的配置文件。
   *
   * @param filePath - 要检查的路径
   * @returns 是 Craft Agent 配置文件时返回 true
   */
  isCraftAgentConfig(filePath: string): boolean {
    const normalizedPath = process.platform === 'win32'
      ? filePath.replace(/\\/g, '/').toLowerCase()
      : filePath.replace(/\\/g, '/');
    return CRAFT_AGENT_CONFIG_PATTERNS.some((pattern) => pattern.test(normalizedPath));
  }

  // ============================================================
  // 内容校验
  // ============================================================

  /**
   * 写配置前的统一入口：先探测文件类型，再分发到对应校验器。
   *
   * 说明：
   * - JSON：直接 JSON.parse，失败则返回错误并尝试定位行号列号。
   * - TOML/YAML：项目没有引入完整解析器，只做基础语法扫描，返回 warnings。
   * - 未知类型：直接放行（valid: true）。
   *
   * @param filePath - 要写入的文件路径
   * @param content - 待校验的内容
   * @returns 校验结果，含 errors / warnings
   */
  validateContent(filePath: string, content: string): ConfigValidationResult {
    const fileType = this.getConfigType(filePath);

    switch (fileType) {
      case 'json':
        return this.validateJson(content);
      case 'toml':
        return this.validateToml(content);
      case 'yaml':
        return this.validateYaml(content);
      default:
        // 未知文件类型，不做校验
        return { valid: true };
    }
  }

  /**
   * 校验 JSON 内容。
   *
   * @param content - 要校验的 JSON 字符串
   * @returns 校验结果
   */
  validateJson(content: string): ConfigValidationResult {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown JSON parse error';

      // 尝试从错误信息中提取行号/列号
      const lineMatch = error.match(/line (\d+)/i);
      const colMatch = error.match(/column (\d+)/i);
      const posMatch = error.match(/position (\d+)/i);

      let detailedError = error;
      if (posMatch?.[1]) {
        const pos = parseInt(posMatch[1], 10);
        const { line, column } = this.getLineColumn(content, pos);
        detailedError = `${error} (line ${line}, column ${column})`;
      } else if (lineMatch?.[1]) {
        detailedError = `${error}`;
      }

      return {
        valid: false,
        errors: [detailedError],
      };
    }
  }

  /**
   * 校验 TOML 内容（基础语法检查）。
   * 说明：完整 TOML 校验需要引入专门的 TOML 解析器，这里只覆盖常见问题。
   *
   * @param content - 要校验的 TOML 字符串
   * @returns 校验结果
   */
  validateToml(content: string): ConfigValidationResult {
    const warnings: string[] = [];

    // TOML 常见问题基础检查
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();

      // 跳过注释和空行
      if (line.startsWith('#') || line === '') continue;

      // 检查节头中是否有未闭合的方括号
      if (line.startsWith('[') && !line.match(/^\[+[^\]]+\]+$/)) {
        warnings.push(`Line ${i + 1}: Possibly malformed section header: ${line}`);
      }

      // 检查键值对中是否缺少等号（节头或数组除外）
      if (!line.startsWith('[') && !line.includes('=') && !line.startsWith(']')) {
        warnings.push(`Line ${i + 1}: Missing '=' in key-value pair: ${line}`);
      }
    }

    return {
      valid: warnings.length === 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 校验 YAML 内容（基础语法检查）。
   * 说明：完整 YAML 校验需要引入专门的 YAML 解析器，这里只覆盖常见问题。
   *
   * @param content - 要校验的 YAML 字符串
   * @returns 校验结果
   */
  validateYaml(content: string): ConfigValidationResult {
    const warnings: string[] = [];

    // YAML 常见问题基础检查
    const lines = content.split('\n');
    let indentStack: number[] = [0];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // 跳过空行与注释
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      // 检查缩进一致性（应使用空格而非制表符）
      if (line.match(/^\t/)) {
        warnings.push(`Line ${i + 1}: Uses tab indentation (YAML prefers spaces)`);
      }

      // 检查行尾冒号是否缺少同行或下一行的值
      if (line.trim().endsWith(':') && !line.includes(': ')) {
        // 这是一个映射键，检查下一行存在且已缩进
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith(' ') && !nextLine.startsWith('\t') && nextLine.trim() !== '') {
          warnings.push(`Line ${i + 1}: Mapping key '${line.trim()}' has no nested content`);
        }
      }
    }

    return {
      valid: true, // YAML warnings are advisory, not errors
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 根据字符位置计算所在的行号和列号。
   */
  private getLineColumn(content: string, position: number): { line: number; column: number } {
    const lines = content.slice(0, position).split('\n');
    const line = lines.length;
    const column = (lines[lines.length - 1]?.length ?? 0) + 1;
    return { line, column };
  }

  /**
   * 把校验结果格式化成便于展示的文本。
   *
   * @param result - 校验结果
   * @param filePath - 文件路径（用于上下文提示）
   * @returns 格式化后的错误字符串
   */
  formatErrors(result: ConfigValidationResult, filePath?: string): string {
    if (result.valid && !result.warnings?.length) {
      return '';
    }

    const parts: string[] = [];

    if (filePath) {
      parts.push(`Validation issues in ${filePath}:`);
    }

    if (result.errors?.length) {
      parts.push('Errors:');
      for (const error of result.errors) {
        parts.push(`  - ${error}`);
      }
    }

    if (result.warnings?.length) {
      parts.push('Warnings:');
      for (const warning of result.warnings) {
        parts.push(`  - ${warning}`);
      }
    }

    return parts.join('\n');
  }
}
