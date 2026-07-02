/**
 * session-tools-core 的校验工具
 *
 * 供 session 级 tool 使用的共享校验逻辑。
 * 在 Claude 和 Codex 两种上下文中都能运行的可移植校验。
 */

import { z } from 'zod';
import matter from 'gray-matter';
import { existsSync, readFileSync } from 'node:fs';
import type { ValidationResult, ValidationIssue } from './types.ts';

/** 去除会干扰 JSON.parse 的 UTF-8 BOM */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// ============================================================
// 校验结果辅助函数
// ============================================================

/**
 * 创建一个表示“通过”的空结果
 */
export function validResult(): ValidationResult {
  return { valid: true, errors: [], warnings: [] };
}

/**
 * 创建一个包含单条错误的结果
 */
export function invalidResult(path: string, message: string, suggestion?: string): ValidationResult {
  return {
    valid: false,
    errors: [{ path, message, suggestion }],
    warnings: [],
  };
}

/**
 * 把多个校验结果合并成一个
 */
export function mergeResults(...results: ValidationResult[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const result of results) {
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// 校验结果格式化
// ============================================================

/**
 * 把校验结果格式化成适合 tool 响应的人类可读文本。
 * 这是 session tool 使用的简化版本。
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push('✓ Validation passed');
  } else {
    lines.push('✗ Validation failed');
  }

  if (result.errors.length > 0) {
    lines.push('\nErrors:');
    for (const error of result.errors) {
      lines.push(`  - ${error.path}: ${error.message}`);
      if (error.suggestion) {
        lines.push(`    → ${error.suggestion}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\nWarnings:');
    for (const warning of result.warnings) {
      lines.push(`  - ${warning.path}: ${warning.message}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// JSON 校验
// ============================================================

/**
 * 校验 JSON 文件是否存在并解析它
 */
export function readJsonFile(filePath: string): { success: true; data: unknown } | { success: false; error: string } {
  if (!existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(stripBom(content));
    return { success: true, data };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Invalid JSON: ${message}` };
  }
}

/**
 * 校验 JSON 文件是否包含指定必填字段
 */
export function validateJsonFileHasFields(
  filePath: string,
  requiredFields: string[]
): ValidationResult {
  const result = readJsonFile(filePath);

  if (!result.success) {
    return invalidResult(filePath, result.error, 'Check file exists and contains valid JSON');
  }

  const errors: ValidationIssue[] = [];
  const data = result.data as Record<string, unknown>;

  for (const field of requiredFields) {
    if (!(field in data)) {
      errors.push({
        path: field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * 把 Zod 错误转换成 ValidationIssue 数组
 */
export function zodErrorToIssues(error: z.ZodError, filePath: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || filePath,
    message: issue.message,
  }));
}

// ============================================================
// Slug 校验
// ============================================================

/**
 * 合法 slug 的正则：小写字母、数字和连字符
 */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * 校验 slug 格式
 */
export function validateSlug(slug: string): ValidationResult {
  if (!SLUG_REGEX.test(slug)) {
    const suggestedSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');

    return invalidResult(
      'slug',
      'Slug must be lowercase alphanumeric with hyphens',
      `Suggested: '${suggestedSlug || 'valid-slug-name'}'`
    );
  }

  return validResult();
}

// ============================================================
// Skill 校验
// ============================================================

/**
 * skill 元数据的 Zod schema（SKILL.md 的 frontmatter）
 */
export const SkillMetadataSchema = z.object({
  name: z.string().min(1, "Add a 'name' field with a human-readable title"),
  description: z.string().min(1, "Add a 'description' field explaining what this skill does"),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
  icon: z.string().optional(),
  requiredSources: z.array(z.string()).optional(),
}).passthrough();

/**
 * 校验 SKILL.md 内容（无需访问文件系统）。
 * Claude 和 Codex 的实现都会使用。
 *
 * @param markdownContent - 完整的 SKILL.md 文件内容
 * @param slug - skill 的 slug（文件夹名），用于校验 slug 格式
 */
export function validateSkillContent(markdownContent: string, slug: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. 校验 slug 格式
  const slugResult = validateSlug(slug);
  errors.push(...slugResult.errors);

  // 2. 解析 frontmatter
  let frontmatter: unknown;
  let body: string;
  try {
    const parsed = matter(markdownContent);
    frontmatter = parsed.data;
    body = parsed.content;
  } catch (e) {
    return invalidResult(
      'frontmatter',
      `Invalid YAML frontmatter: ${e instanceof Error ? e.message : 'Unknown error'}`,
      'Check YAML syntax in frontmatter section'
    );
  }

  // 3. 校验 frontmatter schema
  const metaResult = SkillMetadataSchema.safeParse(frontmatter);
  if (!metaResult.success) {
    errors.push(...zodErrorToIssues(metaResult.error, 'SKILL.md'));
  }

  // 4. 检查正文是否为空
  if (!body || body.trim().length === 0) {
    errors.push({
      path: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Mermaid 校验（基础语法检查）
// ============================================================

/**
 * 合法的 Mermaid 图表类型
 */
export const MERMAID_DIAGRAM_TYPES = [
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram',
  'stateDiagram', 'erDiagram', 'gantt', 'pie', 'mindmap',
  'timeline', 'gitGraph', 'C4Context', 'sankey', 'xychart', 'xychart-beta',
] as const;

/** 移除图表开头的 Mermaid YAML frontmatter（`--- ... ---`）。 */
export function stripMermaidFrontmatter(code: string): string {
  const withoutBom = code.replace(/^\uFEFF/, '');
  const leadingWhitespaceMatch = withoutBom.match(/^\s*/);
  const leadingWhitespace = leadingWhitespaceMatch?.[0] ?? '';
  const candidate = withoutBom.slice(leadingWhitespace.length);
  const lines = candidate.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') return code;

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) return code;

  return lines.slice(endIndex + 1).join('\n').trimStart();
}

/**
 * 在使用原生工具校验/渲染前，对 Mermaid 源码做规范化。
 *
 * Frontmatter 是元数据，不是图表语法。开头的 Mermaid 注释/指令也跳过，
 * 这样图表类型检测才能与渲染管线一致，例如 `xychart-beta`。
 */
export function normalizeMermaidSource(code: string): string {
  const lines = stripMermaidFrontmatter(code).split(/\r?\n/);
  while (lines.length > 0) {
    const first = lines[0]?.trim() ?? '';
    if (first.length === 0 || first.startsWith('%%')) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n').trimStart();
}

function getFirstMermaidDiagramLine(code: string): string {
  return normalizeMermaidSource(code).split(/\r?\n/)[0]?.trim() ?? '';
}

/**
 * 基础 Mermaid 语法校验（不渲染）。
 * 只检查常见语法错误，不需要浏览器。
 */
export function validateMermaidSyntax(code: string): ValidationResult {
  const normalizedCode = normalizeMermaidSource(code);
  const firstLine = getFirstMermaidDiagramLine(code);

  // 检查图表类型声明
  const hasValidType = MERMAID_DIAGRAM_TYPES.some(type =>
    firstLine.startsWith(type) || firstLine.startsWith(`${type}-v2`)
  );

  if (!hasValidType) {
    return invalidResult(
      'diagram',
      `Unknown diagram type. First line should start with one of: ${MERMAID_DIAGRAM_TYPES.join(', ')}`,
      'Check the diagram type declaration'
    );
  }

  // 检查括号是否成对
  const brackets = { '[': 0, '{': 0, '(': 0 };
  for (const char of normalizedCode) {
    if (char === '[') brackets['[']++;
    if (char === ']') brackets['[']--;
    if (char === '{') brackets['{']++;
    if (char === '}') brackets['{']--;
    if (char === '(') brackets['(']++;
    if (char === ')') brackets['(']--;
  }

  const unbalanced = Object.entries(brackets).filter(([, count]) => count !== 0);
  if (unbalanced.length > 0) {
    const issues = unbalanced.map(([b, c]) =>
      `${b}: ${c > 0 ? 'missing closing' : 'extra closing'}`
    ).join(', ');

    return invalidResult(
      'syntax',
      `Unbalanced brackets: ${issues}`,
      'Check bracket matching in the diagram'
    );
  }

  return validResult();
}

// ============================================================
// Source 配置校验（基础版）
// ============================================================

/**
 * source config.json 的必填字段
 */
export const SOURCE_CONFIG_REQUIRED_FIELDS = ['slug', 'name', 'type'];

/**
 * 合法的 source 类型
 */
export const SOURCE_TYPES = ['mcp', 'api', 'local'] as const;

/**
 * 基础的 source 配置校验（schema 级别）。
 * 如需完整的 Zod schema 校验，请使用 packages/shared 里的校验器。
 */
export function validateSourceConfigBasic(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return invalidResult('config', 'Config must be an object');
  }

  const errors: ValidationIssue[] = [];
  const data = config as Record<string, unknown>;

  // 检查必填字段
  for (const field of SOURCE_CONFIG_REQUIRED_FIELDS) {
    if (!(field in data)) {
      errors.push({
        path: field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  // 如果存在 type，校验其合法性
  if ('type' in data && !SOURCE_TYPES.includes(data.type as typeof SOURCE_TYPES[number])) {
    errors.push({
      path: 'type',
      message: `Invalid type: ${data.type}. Must be one of: ${SOURCE_TYPES.join(', ')}`,
    });
  }

  // 如果存在 slug，校验其格式
  if ('slug' in data && typeof data.slug === 'string') {
    const slugResult = validateSlug(data.slug);
    errors.push(...slugResult.errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}
