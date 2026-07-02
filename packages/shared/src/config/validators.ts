/**
 * Config Validators
 *
 * config 文件的 Zod schema 与验证工具。
 * Agent 在让配置生效前会先用这些工具验证变更。
 *
 * 验证范围：
 * - config.json：主应用配置
 * - preferences.json：用户偏好
 * - sources/{slug}/config.json：workspace 级 source 配置
 * - permissions.json：Explore 模式权限规则
 * - tool-icons/tool-icons.json：CLI tool 图标映射
 */

import { z } from 'zod';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { safeJsonParse, readJsonFileSync } from '../utils/files.ts';
import { EntityColorSchema } from '../colors/validate.ts';
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels.ts';
import { isValidProviderAuthCombination } from './llm-connections.ts';
import { SUPPORTED_LANGUAGE_CODES } from '../i18n/languages.ts';
import type { LanguageCode } from '../i18n/languages.ts';

// ============================================================
// Config Directory
// ============================================================

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// ============================================================
// Validation Result Types
// ============================================================

/** 单个验证问题 */
export interface ValidationIssue {
  file: string;
  path: string;  // JSON 路径，如 "workspaces[0].name"
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  fixed?: string[];
}

// ============================================================
// Zod Schemas
// ============================================================

// --- config.json ---

/** Workspace 基础 schema */
const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional(),
  createdAt: z.number().int().positive(),
  sessionId: z.string().optional(),
  iconUrl: z.string().optional(),
});

// --- LLM Connection schema for config validation ---

const LlmProviderTypeSchema = z.enum([
  'anthropic', 'openai', 'openai_compat', 'pi', 'pi_compat', 'copilot',
  // 保留旧值以容忍磁盘配置（运行时迁移）：
  'anthropic_compat', 'bedrock', 'vertex',
]);

const LlmAuthTypeSchema = z.enum([
  'api_key', 'api_key_with_endpoint', 'oauth', 'iam_credentials',
  'bearer_token', 'service_account_file', 'environment', 'none',
]);

const CustomEndpointSchema = z.object({
  api: z.enum(['openai-completions', 'anthropic-messages']),
  supportsImages: z.boolean().optional(),
});

const LlmConnectionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  providerType: LlmProviderTypeSchema,
  authType: LlmAuthTypeSchema,
  baseUrl: z.string().optional(),
  models: z.array(z.union([z.string(), z.object({ id: z.string() }).passthrough()])).optional(),
  defaultModel: z.string().optional(),
  modelSelectionMode: z.enum(['automaticallySyncedFromProvider', 'userDefined3Tier']).optional(),
  customEndpoint: CustomEndpointSchema.optional(),
  createdAt: z.number(),
  // 允许额外字段（codexPath、awsRegion、gcpProjectId 等）
}).passthrough();

export const StoredConfigSchema = z.object({
  workspaces: z.array(WorkspaceSchema).min(0),
  activeWorkspaceId: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  llmConnections: z.array(LlmConnectionSchema).optional(),
  defaultLlmConnection: z.string().optional(),
  defaultThinkingLevel: z.enum([...THINKING_LEVEL_IDS, 'think'] as [string, ...string[]]).transform(v => v === 'think' ? 'medium' : v).optional(),
  // 注意：tokenDisplay、showCost、cumulativeUsage、defaultPermissionMode 已移除
  // permission mode 和 cyclable modes 现在按 workspace 存在 workspace config.json 中
});

// --- preferences.json ---

const LocationSchema = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
});

export const UserPreferencesSchema = z.object({
  name: z.string().optional(),
  timezone: z.string().optional(),  // TODO: 可以校验是否为 IANA 时区列表
  location: LocationSchema.optional(),
  notes: z.string().optional(),
  // 内部字段：与 Appearance → Language 同步，用户不可编辑
  // 校验范围来自 registry 推导的支持集合
  uiLanguage: z.enum([...SUPPORTED_LANGUAGE_CODES] as [LanguageCode, ...LanguageCode[]]).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).passthrough();

// ============================================================
// Validation Functions
// ============================================================

/**
 * 把 Zod 错误转成 ValidationIssue 列表。
 */
function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * 验证 config.json。
 */
export function validateConfig(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 检查文件是否存在
  if (!existsSync(CONFIG_FILE)) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: 'Config file does not exist',
        severity: 'error',
        suggestion: 'Run setup to create initial configuration',
      }],
      warnings: [],
    };
  }

  // 解析 JSON
  let content: unknown;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 schema
  const result = StoredConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'config.json'));
  } else {
    const config = result.data;

    // 语义校验
    if (config.activeWorkspaceId && config.workspaces.length > 0) {
      const activeExists = config.workspaces.some(w => w.id === config.activeWorkspaceId);
      if (!activeExists) {
        errors.push({
          file: 'config.json',
          path: 'activeWorkspaceId',
          message: `Active workspace ID '${config.activeWorkspaceId}' does not exist in workspaces array`,
          severity: 'error',
          suggestion: 'Set activeWorkspaceId to an existing workspace ID or null',
        });
      }
    }

    // 验证 LLM 连接
    if (config.llmConnections) {
      const seenSlugs = new Set<string>();
      for (const [i, conn] of config.llmConnections.entries()) {
        // 检查重复 slug
        if (seenSlugs.has(conn.slug)) {
          errors.push({
            file: 'config.json',
            path: `llmConnections[${i}].slug`,
            message: `Duplicate connection slug '${conn.slug}'`,
            severity: 'error',
            suggestion: 'Each connection must have a unique slug',
          });
        }
        seenSlugs.add(conn.slug);

        // 验证 provider/auth 组合
        if (!isValidProviderAuthCombination(conn.providerType as any, conn.authType as any)) {
          warnings.push({
            file: 'config.json',
            path: `llmConnections[${i}]`,
            message: `Invalid provider/auth combination: providerType='${conn.providerType}' with authType='${conn.authType}'`,
            severity: 'warning',
            suggestion: 'Check supported auth types for this provider',
          });
        }
      }

      // 验证 defaultLlmConnection 引用存在的连接
      if (config.defaultLlmConnection) {
        const exists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
        if (!exists) {
          warnings.push({
            file: 'config.json',
            path: 'defaultLlmConnection',
            message: `Default LLM connection '${config.defaultLlmConnection}' does not exist in llmConnections array`,
            severity: 'warning',
            suggestion: 'Set defaultLlmConnection to an existing connection slug',
          });
        }
      }
    }

  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 验证 preferences.json。
 */
export function validatePreferences(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 文件不存在（preferences 可选）
  if (!existsSync(PREFERENCES_FILE)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'preferences.json',
        path: '',
        message: 'Preferences file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // 解析 JSON
  let content: unknown;
  try {
    const raw = readFileSync(PREFERENCES_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'preferences.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 schema
  const result = UserPreferencesSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'preferences.json'));
  } else {
    const prefs = result.data;

    // 缺少推荐字段时给出警告
    if (!prefs.name) {
      warnings.push({
        file: 'preferences.json',
        path: 'name',
        message: 'User name is not set',
        severity: 'warning',
        suggestion: 'Setting a name helps personalize agent responses',
      });
    }

    if (!prefs.timezone) {
      warnings.push({
        file: 'preferences.json',
        path: 'timezone',
        message: 'Timezone is not set',
        severity: 'warning',
        suggestion: 'Setting timezone helps with date/time formatting',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 验证所有 config 文件。
 * @param workspaceId - 可选 workspace ID，用于 source 验证
 * @param workspaceRoot - 可选 workspace 根路径，用于 skill、status、label、automations、permissions 验证
 */
export function validateAll(workspaceId?: string, workspaceRoot?: string): ValidationResult {
  const results: ValidationResult[] = [
    validateConfig(),
    validatePreferences(),
    validateToolIcons(),
  ];

  // 提供 workspaceId 时加入 source 验证
  if (workspaceId) {
    results.push(validateAllSources(workspaceId));
  }

  // 提供 workspaceRoot 时加入 skill、status、label、automations、permissions 验证
  if (workspaceRoot) {
    results.push(validateAllSkills(workspaceRoot));
    results.push(validateStatuses(workspaceRoot));
    results.push(validateLabels(workspaceRoot));
    results.push(validateAutomations(workspaceRoot));
    results.push(validateAllPermissions(workspaceRoot));
  }

  const allErrors = results.flatMap(r => r.errors);
  const allWarnings = results.flatMap(r => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// ============================================================
// Source & Agent Validators (Folder-Based Architecture)
// ============================================================

import { getWorkspaceSourcesPath } from '../workspaces/storage.ts';

// --- sources/{slug}/config.json ---

const SourceTypeSchema = z.enum(['mcp', 'api', 'local']);

// MCP source 支持两种 transport：
// - HTTP/SSE：需要 url 和 authType
// - Stdio：需要 command（可选 args、env）
const McpSourceConfigSchema = z.object({
  transport: z.enum(['http', 'sse', 'stdio']).optional(),
  // HTTP/SSE 字段
  url: z.string().url().optional(),
  authType: z.enum(['oauth', 'bearer', 'none']).optional(),
  clientId: z.string().optional(),
  // Stdio 字段
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // HTTP/SSE transport 的自定义 header（如 API key、自定义 auth）
  headers: z.record(z.string(), z.string()).optional(),
  // 凭据存储认证的 header 名（值以 JSON 形式存在 credential store）
  headerNames: z.array(z.string()).optional(),
}).refine(
  (data) => {
    if (data.transport === 'stdio') {
      // Stdio transport 必须有 command
      return !!data.command;
    } else {
      // HTTP/SSE transport（默认）必须有 url 和 authType
      return !!data.url && !!data.authType;
    }
  },
  {
    message: 'MCP config requires either (url + authType) for HTTP/SSE or (command) for stdio transport',
  }
);

const ApiOAuthConfigSchema = z.object({
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
});

const ApiSourceConfigSchema = z.object({
  baseUrl: z.string().url(),
  authType: z.enum(['bearer', 'header', 'query', 'basic', 'oauth', 'none']),
  headerName: z.string().optional(),
  headerNames: z.array(z.string()).optional(),
  queryParam: z.string().optional(),
  authScheme: z.string().optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  testEndpoint: z
    .object({
      method: z.enum(['GET', 'POST']),
      path: z.string(),
      body: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  googleService: z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'youtube', 'searchconsole']).optional(),
  googleScopes: z.array(z.string()).optional(),
  googleOAuthClientId: z.string().optional(),
  googleOAuthClientSecret: z.string().optional(),
  slackService: z.enum(['messaging', 'channels', 'users', 'files', 'full']).optional(),
  slackUserScopes: z.array(z.string()).optional(),
  microsoftService: z.enum(['outlook', 'microsoft-calendar', 'onedrive', 'teams', 'sharepoint']).optional(),
  microsoftScopes: z.array(z.string()).optional(),
  oauth: ApiOAuthConfigSchema.optional(),
});

const LocalSourceConfigSchema = z.object({
  path: z.string().min(1),
  format: z.string().optional(),
});

// Source brand schema
const SourceBrandSchema = z.object({
  color: EntityColorSchema.optional(),
});

export const FolderSourceConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  enabled: z.boolean(),
  provider: z.string().min(1),
  type: SourceTypeSchema,
  mcp: McpSourceConfigSchema.optional(),
  api: ApiSourceConfigSchema.optional(),
  local: LocalSourceConfigSchema.optional(),
  brand: SourceBrandSchema.optional(),
  isAuthenticated: z.boolean().optional(),
  lastTestedAt: z.number().int().min(0).optional(),
  // 时间戳可选：手工创建的配置可能没有，保存时 storage 函数会自动加上
  createdAt: z.number().int().min(0).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).refine(
  (data) => {
    // 确保 type 对应的配置块存在
    switch (data.type) {
      case 'mcp': return !!data.mcp;
      case 'api': return !!data.api;
      case 'local': return !!data.local;
    }
  },
  { message: 'Config must include type-specific configuration (mcp, api, or local)' }
);

/**
 * 验证内存中的 source config 对象（不读盘）。
 */
export function validateSourceConfig(config: unknown): ValidationResult {
  const result = FolderSourceConfigSchema.safeParse(config);

  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }

  return {
    valid: false,
    errors: zodErrorToIssues(result.error, 'config.json'),
    warnings: [],
  };
}

/**
 * 从 JSON 字符串验证 source config。
 * PreToolUse hook 在写入磁盘前用它校验。
 */
export function validateSourceConfigContent(jsonString: string): ValidationResult {
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validateSourceConfig(content);
}

/**
 * 验证 workspace 中的某个 source 文件夹（读盘）。
 */
export function validateSource(workspaceId: string, slug: string): ValidationResult {
  const sourcesDir = getWorkspaceSourcesPath(workspaceId);
  const file = `sources/${slug}/config.json`;
  const configPath = join(sourcesDir, slug, 'config.json');

  if (!existsSync(join(sourcesDir, slug))) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Source folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  if (!existsSync(configPath)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'config.json not found',
        severity: 'error',
        suggestion: 'Create a config.json file in the source folder',
      }],
      warnings: [],
    };
  }

  let content: unknown;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  const result = validateSourceConfig(content);

  // 缺 guide.md 时给出警告
  const guidePath = join(sourcesDir, slug, 'guide.md');
  if (!existsSync(guidePath)) {
    result.warnings.push({
      file: `sources/${slug}/guide.md`,
      path: '',
      message: 'guide.md not found (recommended for usage guidelines)',
      severity: 'warning',
    });
  }

  return result;
}

/**
 * 验证 workspace 中的所有 sources。
 */
export function validateAllSources(workspaceId: string): ValidationResult {
  const sourcesDir = getWorkspaceSourcesPath(workspaceId);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(sourcesDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'Sources directory does not exist (no sources configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(sourcesDir);
  const sourceFolders = entries.filter((entry) => {
    const entryPath = join(sourcesDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (sourceFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'No sources configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of sourceFolders) {
    const result = validateSource(workspaceId, folder);
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
// Skill Validators
// ============================================================

import matter from 'gray-matter';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { basename, extname } from 'path';

/**
 * Skill 元数据 schema（SKILL.md frontmatter）。
 */
export const SkillMetadataSchema = z.object({
  name: z.string().min(1, "Add a 'name' field with a human-readable title (e.g., 'Git Commit Helper')"),
  description: z.string().min(1, "Add a 'description' field explaining what this skill does and when to use it (1-2 sentences)"),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
});

/**
 * 在 skill 目录中查找图标文件。
 */
function findSkillIconForValidation(skillDir: string): string | null {
  const iconExtensions = ['.svg', '.png', '.jpg', '.jpeg'];

  for (const ext of iconExtensions) {
    const iconPath = join(skillDir, `icon${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }

  return null;
}

/**
 * 验证一个 skill 文件夹。
 * @param workspaceRoot - workspace 根目录绝对路径
 * @param slug - skill 目录名
 */
export function validateSkill(workspaceRoot: string, slug: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');
  const file = `skills/${slug}/SKILL.md`;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. 检查目录是否存在（slug 格式由 validateSkillContent 校验）
  if (!existsSync(skillDir)) {
    return {
      valid: false,
      errors: [{
        file: `skills/${slug}`,
        path: '',
        message: `Skill folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 3. 检查 SKILL.md 是否存在
  if (!existsSync(skillFile)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'SKILL.md not found',
        severity: 'error',
        suggestion: 'Create a SKILL.md file with YAML frontmatter',
      }],
      warnings: [],
    };
  }

  // 4. 读取并委托给内容校验器
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 委托内容校验（frontmatter schema + 正文非空 + slug 格式）
  const contentResult = validateSkillContent(content, slug);
  errors.push(...contentResult.errors);

  // 5. 文件系统层面的检查：图标存在性（仅警告）
  const iconPath = findSkillIconForValidation(skillDir);
  if (iconPath) {
    const ext = extname(iconPath).toLowerCase();
    if (!['.svg', '.png', '.jpg', '.jpeg'].includes(ext)) {
      warnings.push({
        file: `skills/${slug}/${basename(iconPath)}`,
        path: '',
        message: `Unexpected icon format: ${ext}`,
        severity: 'warning',
        suggestion: 'Use .svg, .png, or .jpg for icons',
      });
    }
  } else {
    const searchTerm = slug.replace(/-/g, ' ');
    warnings.push({
      file: `skills/${slug}/`,
      path: 'icon',
      message: 'No icon found',
      severity: 'warning',
      suggestion: `Search for '${searchTerm} icon' on heroicons.com, lucide.dev, or icons8.com. Save as icon.svg in the skill folder.`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 从字符串验证 SKILL.md 内容（不读盘）。
 * PreToolUse hook 在写入磁盘前用它校验。
 * 检查 frontmatter schema 和正文非空。跳过图标/文件夹检查。
 *
 * @param markdownContent - 完整的 SKILL.md 文件内容
 * @param slug - skill slug（目录名），用于 slug 格式校验
 */
export function validateSkillContent(markdownContent: string, slug: string): ValidationResult {
  const file = `skills/${slug}/SKILL.md`;
  const errors: ValidationIssue[] = [];

  // 1. 校验 slug 格式
  if (!/^[a-z0-9-]+$/.test(slug)) {
    const suggestedSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    errors.push({
      file: `skills/${slug}`,
      path: 'slug',
      message: 'Slug must be lowercase alphanumeric with hyphens',
      severity: 'error',
      suggestion: `Rename folder to '${suggestedSlug || 'valid-slug-name'}'`,
    });
  }

  // 2. 解析 frontmatter
  let frontmatter: unknown;
  let body: string;
  try {
    const parsed = matter(markdownContent);
    frontmatter = parsed.data;
    body = parsed.content;
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: 'frontmatter',
        message: `Invalid YAML frontmatter: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
        suggestion: 'See ~/.craft-agent/docs/skills.md for SKILL.md format reference',
      }],
      warnings: [],
    };
  }

  // 3. 校验 frontmatter schema
  const metaResult = SkillMetadataSchema.safeParse(frontmatter);
  if (!metaResult.success) {
    errors.push(...zodErrorToIssues(metaResult.error, file));
  }

  // 4. 检查正文非空
  if (!body || body.trim().length === 0) {
    errors.push({
      file,
      path: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      severity: 'error',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],  // 仅内容校验，跳过图标/文件夹警告
  };
}

/**
 * 验证 workspace 中的所有 skills。
 * @param workspaceRoot - workspace 根目录绝对路径
 */
export function validateAllSkills(workspaceRoot: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(skillsDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'Skills directory does not exist (no skills configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(skillsDir);
  const skillFolders = entries.filter((entry) => {
    const entryPath = join(skillsDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (skillFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'No skills configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of skillFolders) {
    const result = validateSkill(workspaceRoot, folder);
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
// Status Validators
// ============================================================

const STATUS_CONFIG_FILE = 'statuses/config.json';

/** 必须始终存在的固定 status */
const REQUIRED_FIXED_STATUS_IDS = ['todo', 'done', 'cancelled'] as const;

/**
 * Status 图标是简单字符串：emoji、URL 或本地文件名（如 "in-progress.svg"），
 * 运行时会解析为 statuses/icons/in-progress.svg。
 * 省略 icon 时，运行时仍会从 statuses/icons/{id}.svg 自动发现。
 */
const StatusIconSchema = z.string();

/**
 * 单个 status 配置的 Zod schema。
 */
const StatusConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Status ID must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1, 'Status label is required'),
  color: EntityColorSchema.optional(),
  icon: StatusIconSchema.optional(),
  category: z.enum(['open', 'closed']),
  isFixed: z.boolean(),
  isDefault: z.boolean(),
  order: z.number().int().min(0),
});

/**
 * workspace status 配置的 Zod schema。
 */
const WorkspaceStatusConfigSchema = z.object({
  version: z.number().int().min(1),
  statuses: z.array(StatusConfigSchema),
  defaultStatusId: z.string().min(1),
});

/**
 * 验证 workspace 的 status 配置。
 * @param workspaceRoot - workspace 根目录绝对路径
 */
export function validateStatuses(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, STATUS_CONFIG_FILE);
  const file = STATUS_CONFIG_FILE;

  // 文件可选 —— 缺失时使用默认值
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Status config does not exist (using defaults)',
        severity: 'warning',
        suggestion: 'Statuses will use default configuration. Edit to customize.',
      }],
    };
  }

  // 读取文件并委托给内容校验器
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 图标在运行时从 statuses/icons/{id}.{ext} 自动发现，不写在 config 里，因此这里不做文件检查。
  return validateStatusesContent(raw);
}

/**
 * 从 JSON 字符串验证 status 配置（不读盘）。
 * PreToolUse hook 在写入磁盘前用它校验。
 * 执行 schema 校验和语义检查。跳过图标文件存在性检查。
 */
export function validateStatusesContent(jsonString: string): ValidationResult {
  const file = 'statuses/config.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 解析 JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 schema
  const result = WorkspaceStatusConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // 语义校验（与 validateStatuses 相同，但不包含文件系统检查）

  // 1. 检查必需的固定 status 是否存在
  const statusIds = new Set(config.statuses.map(s => s.id));
  for (const requiredId of REQUIRED_FIXED_STATUS_IDS) {
    if (!statusIds.has(requiredId)) {
      errors.push({
        file,
        path: 'statuses',
        message: `Required fixed status '${requiredId}' is missing`,
        severity: 'error',
        suggestion: `Add the '${requiredId}' status - it's required for the system to function`,
      });
    }
  }

  // 2. 检查重复 ID
  const seenIds = new Set<string>();
  for (const status of config.statuses) {
    if (seenIds.has(status.id)) {
      errors.push({
        file,
        path: `statuses[id=${status.id}]`,
        message: `Duplicate status ID '${status.id}'`,
        severity: 'error',
        suggestion: 'Each status must have a unique ID',
      });
    }
    seenIds.add(status.id);
  }

  // 3. 检查 defaultStatusId 引用存在的 status
  if (!statusIds.has(config.defaultStatusId)) {
    errors.push({
      file,
      path: 'defaultStatusId',
      message: `Default status '${config.defaultStatusId}' does not exist in statuses array`,
      severity: 'error',
      suggestion: 'Set defaultStatusId to an existing status ID (typically "todo")',
    });
  }

  // 4. 检查固定 status 的 isFixed 标志是否正确
  for (const status of config.statuses) {
    const shouldBeFixed = (REQUIRED_FIXED_STATUS_IDS as readonly string[]).includes(status.id);
    if (shouldBeFixed && !status.isFixed) {
      warnings.push({
        file,
        path: `statuses[id=${status.id}].isFixed`,
        message: `Status '${status.id}' should have isFixed: true`,
        severity: 'warning',
        suggestion: 'This is a required system status and should be marked as fixed',
      });
    }
  }

  // 5. 检查每个 category 至少有一个 status
  const hasOpen = config.statuses.some(s => s.category === 'open');
  const hasClosed = config.statuses.some(s => s.category === 'closed');
  if (!hasOpen) {
    errors.push({
      file,
      path: 'statuses',
      message: 'No status with category "open" - sessions will not appear in inbox',
      severity: 'error',
    });
  }
  if (!hasClosed) {
    warnings.push({
      file,
      path: 'statuses',
      message: 'No status with category "closed" - sessions cannot be archived',
      severity: 'warning',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Labels Validators
// ============================================================

import { validateAutoLabelRule } from '../labels/auto/validation.ts';

const LABEL_CONFIG_FILE = 'labels/config.json';

/** 标签树最大嵌套深度（防止过深层级） */
const MAX_LABEL_DEPTH = 5;

/**
 * 自动标签规则 schema（用于自动应用标签的正则模式）。
 * 校验 pattern 非空；正则合法性在下面语义校验。
 */
const AutoLabelRuleSchema = z.object({
  pattern: z.string().min(1, 'Auto-label rule pattern is required'),
  flags: z.string().optional(),
  valueTemplate: z.string().optional(),
  description: z.string().optional(),
});

const BaseLabelConfigSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Label ID must be a simple slug (lowercase alphanumeric + hyphens, e.g., "bug", "frontend")'
  ),
  name: z.string().min(1, 'Label name is required'),
  color: EntityColorSchema.optional(),
  icon: z.string().optional(),
  /** 可选提示：该标签携带的值类型（布尔标签可省略） */
  valueType: z.enum(['string', 'number', 'date', 'link']).optional(),
  /** 自动标签规则：扫描消息并自动应用标签的正则模式 */
  autoRules: z.array(AutoLabelRuleSchema).optional(),
});

// 递归 schema：LabelConfig 可以有 children，children 也是 LabelConfig。
// Zod 用 lazy() 支持递归类型。
type LabelConfigSchemaType = z.ZodType<{
  id: string;
  name: string;
  color?: unknown;
  icon?: string;
  valueType?: 'string' | 'number' | 'date' | 'link';
  autoRules?: Array<{ pattern: string; flags?: string; valueTemplate?: string; description?: string }>;
  children?: LabelConfigSchemaType[];
}>;

const LabelConfigSchema: z.ZodType<any> = BaseLabelConfigSchema.extend({
  children: z.lazy(() => z.array(LabelConfigSchema)).optional(),
});

/**
 * workspace 标签配置的 Zod schema（递归树）
 */
const WorkspaceLabelConfigSchema = z.object({
  version: z.number().int().min(1),
  labels: z.array(LabelConfigSchema),
});

/**
 * 验证 workspace 的 labels 配置（读盘）。
 * @param workspaceRoot - workspace 根目录绝对路径
 */
export function validateLabels(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, LABEL_CONFIG_FILE);
  const file = LABEL_CONFIG_FILE;

  // Labels 配置可选 —— 没有即无标签（合法状态）
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Labels config does not exist (no labels configured)',
        severity: 'warning',
      }],
    };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validateLabelsContent(raw);
}

/**
 * 从 JSON 字符串验证 labels 配置（不读盘）。
 * PreToolUse hook 在写入磁盘前用它校验。
 * 检查 schema 校验和语义规则（唯一 ID、最大深度）。
 */
export function validateLabelsContent(jsonString: string): ValidationResult {
  const file = 'labels/config.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 解析 JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 schema（递归，包含通过 Zod 的 EntityColor 校验）
  const result = WorkspaceLabelConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // 1. 检查整棵树全局唯一 ID
  const seenIds = new Set<string>();
  function checkUniqueIds(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (seenIds.has(label.id)) {
        errors.push({
          file,
          path: `${path}[${i}].id`,
          message: `Duplicate label ID '${label.id}' — IDs must be globally unique across the tree`,
          severity: 'error',
          suggestion: 'Each label must have a unique ID regardless of nesting level',
        });
      }
      seenIds.add(label.id);
      if (label.children && label.children.length > 0) {
        checkUniqueIds(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkUniqueIds(config.labels, 'labels');

  // 2. 检查最大嵌套深度（防止过深层级）
  function checkDepth(labels: any[], depth: number, path: string): void {
    if (depth > MAX_LABEL_DEPTH) {
      errors.push({
        file,
        path,
        message: `Label tree exceeds maximum depth of ${MAX_LABEL_DEPTH} levels`,
        severity: 'error',
        suggestion: `Flatten the hierarchy — ${MAX_LABEL_DEPTH} levels should be sufficient for any organization scheme`,
      });
      return;
    }
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.children && label.children.length > 0) {
        checkDepth(label.children, depth + 1, `${path}[${i}].children`);
      }
    }
  }
  checkDepth(config.labels, 1, 'labels');

  // 3. 校验自动标签规则的正则
  function checkAutoRules(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.autoRules && Array.isArray(label.autoRules)) {
        for (let j = 0; j < label.autoRules.length; j++) {
          const rule = label.autoRules[j];
          if (rule.pattern) {
            const ruleResult = validateAutoLabelRule(rule.pattern, rule.flags);
            for (const err of ruleResult.errors) {
              errors.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: err,
                severity: 'error',
                suggestion: 'Fix the regex pattern or remove the rule',
              });
            }
            for (const warn of ruleResult.warnings) {
              warnings.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: warn,
                severity: 'warning',
              });
            }
          } else {
            errors.push({
              file,
              path: `${path}[${i}].autoRules[${j}]`,
              message: 'Auto-label rule must have a "pattern" field',
              severity: 'error',
              suggestion: 'Add a regex pattern string to the rule',
            });
          }
        }
      }
      if (label.children && label.children.length > 0) {
        checkAutoRules(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkAutoRules(config.labels, 'labels');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Permissions Validators
// ============================================================

import { PermissionsConfigSchema } from '../agent/mode-types.ts';
import {
  validatePermissionsConfig,
  getWorkspacePermissionsPath,
  getSourcePermissionsPath,
  getAppPermissionsDir,
} from '../agent/permissions-config.ts';
import { validateAutomationsContent, validateAutomations, AUTOMATIONS_CONFIG_FILE } from '../automations/index.ts';

/**
 * 内部：验证单个 permissions.json 文件。
 * 检查 JSON 语法、Zod schema 和正则模式合法性。
 */
function validatePermissionsFile(filePath: string, displayFile: string): ValidationResult {
  // 文件可选 —— 缺失只是警告
  if (!existsSync(filePath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: displayFile,
        path: '',
        message: 'Permissions file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // 读取文件并委托给内容校验器
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validatePermissionsContent(raw, displayFile);
}

/**
 * 从 JSON 字符串验证 permissions 配置（不读盘）。
 * PreToolUse hook 在写入磁盘前用它校验。
 * 执行 Zod schema 校验和正则编译检查。
 *
 * @param jsonString - permissions 文件原始 JSON 内容
 * @param displayFile - 错误消息中的文件名（如 'permissions.json' 或 'sources/github/permissions.json'）
 */
export function validatePermissionsContent(jsonString: string, displayFile: string = 'permissions.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // 解析 JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 schema
  const result = PermissionsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  // 语义校验：校验正则模式
  const regexErrors = validatePermissionsConfig(result.data);
  for (const regexError of regexErrors) {
    errors.push({
      file: displayFile,
      path: regexError.split(':')[0] || '',
      message: regexError,
      severity: 'error',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * 验证 workspace 级 permissions.json。
 * @param workspaceRoot - workspace 根目录绝对路径
 */
export function validateWorkspacePermissions(workspaceRoot: string): ValidationResult {
  const permissionsPath = getWorkspacePermissionsPath(workspaceRoot);
  return validatePermissionsFile(permissionsPath, 'permissions.json');
}

/**
 * 验证 source 级 permissions.json。
 * @param workspaceRoot - workspace 根目录绝对路径
 * @param sourceSlug - source slug
 */
export function validateSourcePermissions(workspaceRoot: string, sourceSlug: string): ValidationResult {
  const permissionsPath = getSourcePermissionsPath(workspaceRoot, sourceSlug);
  return validatePermissionsFile(permissionsPath, `sources/${sourceSlug}/permissions.json`);
}

/**
 * 验证应用级默认权限。
 */
export function validateDefaultPermissions(): ValidationResult {
  const permissionsPath = join(getAppPermissionsDir(), 'default.json');
  return validatePermissionsFile(permissionsPath, 'permissions/default.json');
}

/**
 * 验证 workspace 中的所有 permissions 文件。
 * 包括：应用级默认、workspace 级、所有 source 级 permissions。
 */
export function validateAllPermissions(workspaceRoot: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 应用级默认权限
  const defaultResult = validateDefaultPermissions();
  errors.push(...defaultResult.errors);
  warnings.push(...defaultResult.warnings);

  // workspace 级权限
  const wsResult = validateWorkspacePermissions(workspaceRoot);
  errors.push(...wsResult.errors);
  warnings.push(...wsResult.warnings);

  // 所有 source 级权限
  const sourcesDir = join(workspaceRoot, 'sources');
  if (existsSync(sourcesDir)) {
    const entries = readdirSync(sourcesDir);
    for (const entry of entries) {
      const entryPath = join(sourcesDir, entry);
      if (statSync(entryPath).isDirectory()) {
        const srcResult = validateSourcePermissions(workspaceRoot, entry);
        errors.push(...srcResult.errors);
        warnings.push(...srcResult.warnings);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 检查给定路径的 permissions 文件是否有效。
 * 文件存在且通过 schema 校验时返回 true。
 */
export function isValidPermissionsFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validatePermissionsContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Theme Validators
// ============================================================

const CSSColorSchema = z.string().min(1);

const ThemeDarkOverrideSchema = z.object({
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
}).strict();

/**
 * 应用级主题覆盖文件（~/.craft-agent/theme.json）的 Zod schema。
 * 允许部分覆盖，但拒绝未知 key。
 */
export const ThemeOverrideSchema = z.object({
  // 语义色
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // 表面色
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic 模式
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // 深色模式覆盖
  dark: ThemeDarkOverrideSchema.optional(),
}).strict()
  .refine(
    (data) => {
      const keys = Object.keys(data);
      return keys.length > 0;
    },
    { message: 'Theme override must include at least one supported field' }
  )
  .refine(
    (data) => data.mode !== 'scenic' || Boolean(data.backgroundImage),
    { message: 'backgroundImage is required when mode is scenic', path: ['backgroundImage'] }
  );

/**
 * 预设主题文件的 Zod schema。
 * 校验主题结构并要求至少有一个颜色属性。
 */
export const PresetThemeSchema = z.object({
  name: z.string().min(1, 'Theme name is required'),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  source: z.string().optional(),
  supportedModes: z.array(z.enum(['light', 'dark'])).optional(),
  // 语义色
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // 表面色
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic 模式
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // 深色模式覆盖
  dark: z.object({}).passthrough().optional(),
  // Shiki 语法高亮主题
  shikiTheme: z.object({
    light: z.string().optional(),
    dark: z.string().optional(),
  }).optional(),
}).refine(
  (data) => {
    const colorProps = ['background', 'foreground', 'accent', 'info', 'success', 'destructive'];
    return colorProps.some(prop => prop in data);
  },
  { message: 'Theme must have at least one color property (background, foreground, accent, info, success, or destructive)' }
);

/**
 * 从 JSON 字符串验证 theme 内容（不读盘）。
 * 用于在决定覆盖前检查现有主题文件是否有效。
 */
export function validateThemeContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // 解析 JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 schema
  const result = PresetThemeSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * 从 JSON 字符串验证应用级主题覆盖内容（不读盘）。
 * 与预设主题校验不同：接受部分 ThemeOverrides 对象并拒绝未知 key。
 */
export function validateThemeOverrideContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // 解析 JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 schema
  const result = ThemeOverrideSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * 检查给定路径的主题文件是否有效。
 * 文件存在且通过 schema 校验时返回 true。
 */
export function isValidThemeFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validateThemeContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Tool Icons Validators
// ============================================================

import { getToolIconsDir } from './storage.ts';

/**
 * tool-icons.json 中单条 tool icon 条目的 Zod schema。
 * 每条把 CLI 命令映射到一个图标文件。
 */
const ToolIconEntrySchema = z.object({
  id: z.string().min(1, 'Tool ID is required').regex(
    /^[a-z0-9-]+$/,
    'ID must be lowercase alphanumeric with hyphens (e.g., "my-tool")'
  ),
  displayName: z.string().min(1, 'Display name is required'),
  icon: z.string().min(1, 'Icon filename is required'),
  commands: z.array(z.string().min(1)).min(1, 'At least one command is required'),
});

/**
 * 完整 tool-icons.json 配置的 Zod schema。
 * 包含版本号和 tool icon 映射数组。
 */
const ToolIconsConfigSchema = z.object({
  version: z.number().int().min(1, 'Version must be a positive integer'),
  tools: z.array(ToolIconEntrySchema),
});

/**
 * 从 JSON 字符串验证 tool-icons 配置（不读盘）。
 * PreToolUse hook 在写入磁盘前用它校验。
 * 检查 JSON 语法、Zod schema、重复 ID 和重复命令。
 */
export function validateToolIconsContent(jsonString: string): ValidationResult {
  const file = 'tool-icons/tool-icons.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 解析 JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 校验 Zod schema
  const result = ToolIconsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // 语义校验：检查重复 tool ID
  const seenIds = new Set<string>();
  for (const tool of config.tools) {
    if (seenIds.has(tool.id)) {
      errors.push({
        file,
        path: `tools[id=${tool.id}]`,
        message: `Duplicate tool ID '${tool.id}'`,
        severity: 'error',
        suggestion: 'Each tool must have a unique ID',
      });
    }
    seenIds.add(tool.id);
  }

  // 语义校验：跨 tool 重复命令时警告
  const seenCommands = new Map<string, string>();
  for (const tool of config.tools) {
    for (const cmd of tool.commands) {
      if (seenCommands.has(cmd)) {
        warnings.push({
          file,
          path: `tools[id=${tool.id}].commands`,
          message: `Command '${cmd}' is also mapped by tool '${seenCommands.get(cmd)}'`,
          severity: 'warning',
          suggestion: 'Commands should be unique across tools for unambiguous icon resolution',
        });
      } else {
        seenCommands.set(cmd, tool.id);
      }
    }
  }

  // 校验图标文件扩展名
  const validIconExtensions = new Set(['.png', '.ico', '.svg', '.jpg', '.jpeg']);
  for (const tool of config.tools) {
    const ext = tool.icon.includes('.') ? '.' + tool.icon.split('.').pop()!.toLowerCase() : '';
    if (!validIconExtensions.has(ext)) {
      warnings.push({
        file,
        path: `tools[id=${tool.id}].icon`,
        message: `Icon '${tool.icon}' has unrecognized extension '${ext}'`,
        severity: 'warning',
        suggestion: 'Supported formats: .png, .ico, .svg, .jpg',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 从磁盘验证 tool-icons/tool-icons.json。
 * 读取文件、运行内容校验，并检查引用的图标文件是否存在。
 */
export function validateToolIcons(): ValidationResult {
  const toolIconsDir = getToolIconsDir();
  const configPath = join(toolIconsDir, 'tool-icons.json');
  const file = 'tool-icons/tool-icons.json';

  // 文件可选 —— 缺失只是警告
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Tool icons config does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // 读取文件并委托给内容校验器
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  const result = validateToolIconsContent(raw);

  // 文件系统层面检查：引用的图标文件是否存在
  try {
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    if (parsed.tools && Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.icon) {
          const iconPath = join(toolIconsDir, tool.icon);
          if (!existsSync(iconPath)) {
            result.warnings.push({
              file: `tool-icons/${tool.icon}`,
              path: `tools[id=${tool.id}].icon`,
              message: `Icon file '${tool.icon}' not found in tool-icons directory`,
              severity: 'warning',
              suggestion: `Place '${tool.icon}' in ~/.craft-agent/tool-icons/`,
            });
          }
        }
      }
    }
  } catch {
    // JSON 解析错误已由内容校验器报告
  }

  return result;
}

// ============================================================
// Formatting
// ============================================================

/**
 * 把验证结果格式化成给 Agent 回复的文本。
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid && result.warnings.length === 0) {
    lines.push('All configuration files are valid.');
    return lines.join('\n');
  }

  if (result.valid) {
    lines.push('Configuration is valid with warnings:');
  } else {
    lines.push('Configuration has errors:');
  }

  lines.push('');

  // 先输出 errors
  if (result.errors.length > 0) {
    lines.push('**Errors:**');
    for (const error of result.errors) {
      lines.push(`- \`${error.file}\` at \`${error.path}\`: ${error.message}`);
      if (error.suggestion) {
        lines.push(`  → ${error.suggestion}`);
      }
    }
    lines.push('');
  }

  // 再输出 warnings
  if (result.warnings.length > 0) {
    lines.push('**Warnings:**');
    for (const warning of result.warnings) {
      lines.push(`- \`${warning.file}\` at \`${warning.path}\`: ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`  → ${warning.suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================
// PreToolUse Content Validation
// ============================================================
// 这些工具被 PreToolUse hook 用来检测正在写入的配置文件，
// 在内容到达磁盘前进行验证。

/**
 * 检测某路径对应哪种配置文件类型的结果。
 */
export interface ConfigFileDetection {
  type: 'source' | 'skill' | 'statuses' | 'labels' | 'permissions' | 'tool-icons' | 'automations';
  /** source 或 skill 的 slug（如适用） */
  slug?: string;
  /** 错误消息中使用的展示文件路径 */
  displayFile: string;
}

/**
 * 检测文件路径是否对应 workspace 内的已知配置文件。
 * 不是已知配置文件时返回 null。
 *
 * 匹配模式：
 * - .../sources/{slug}/config.json → source config
 * - .../skills/{slug}/SKILL.md → skill definition
 * - .../statuses/config.json → status workflow config
 * - .../labels/config.json → label config
 * - .../permissions.json（workspace 或 source 级）→ permission rules
 */
export function detectConfigFileType(filePath: string, workspaceRootPath: string): ConfigFileDetection | null {
  // 统一为正斜杠，并确保 root 以 / 结尾，
  // 防止 startsWith 误匹配路径前缀（如 /workspace 与 /workspacefoo）
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/?$/, '/');

  // 只验证 workspace root 内的文件
  if (!normalizedPath.startsWith(normalizedRoot)) {
    return null;
  }

  // 取相对路径（root 以 / 结尾，所以没有前导 /）
  const relativePath = normalizedPath.slice(normalizedRoot.length);

  // 匹配：sources/{slug}/config.json
  const sourceMatch = relativePath.match(/^sources\/([^/]+)\/config\.json$/);
  if (sourceMatch) {
    return { type: 'source', slug: sourceMatch[1], displayFile: `sources/${sourceMatch[1]}/config.json` };
  }

  // 匹配：skills/{slug}/SKILL.md
  const skillMatch = relativePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch) {
    return { type: 'skill', slug: skillMatch[1], displayFile: `skills/${skillMatch[1]}/SKILL.md` };
  }

  // 匹配：statuses/config.json
  if (relativePath === 'statuses/config.json') {
    return { type: 'statuses', displayFile: 'statuses/config.json' };
  }

  // 匹配：labels/config.json
  if (relativePath === 'labels/config.json') {
    return { type: 'labels', displayFile: 'labels/config.json' };
  }

  // 匹配：automations 配置文件
  if (relativePath === AUTOMATIONS_CONFIG_FILE) {
    return { type: 'automations', displayFile: relativePath };
  }

  // 匹配：workspace 级 permissions.json
  if (relativePath === 'permissions.json') {
    return { type: 'permissions', displayFile: 'permissions.json' };
  }

  // 匹配：sources/{slug}/permissions.json
  const sourcePermMatch = relativePath.match(/^sources\/([^/]+)\/permissions\.json$/);
  if (sourcePermMatch) {
    return { type: 'permissions', slug: sourcePermMatch[1], displayFile: `sources/${sourcePermMatch[1]}/permissions.json` };
  }

  return null;
}

/**
 * 检测文件路径是否对应应用级配置文件（workspace 范围外）。
 * 检查相对于 CONFIG_DIR（~/.craft-agent/）的路径。
 * 不是已知应用级配置文件时返回 null。
 *
 * 匹配模式：
 * - ~/.craft-agent/tool-icons/tool-icons.json → tool icon mappings
 */
export function detectAppConfigFileType(filePath: string): ConfigFileDetection | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedConfigDir = CONFIG_DIR.replace(/\\/g, '/').replace(/\/?$/, '/');

  // 只检查 CONFIG_DIR 内的文件
  if (!normalizedPath.startsWith(normalizedConfigDir)) {
    return null;
  }

  const relativePath = normalizedPath.slice(normalizedConfigDir.length);

  // 匹配：tool-icons/tool-icons.json
  if (relativePath === 'tool-icons/tool-icons.json') {
    return { type: 'tool-icons', displayFile: 'tool-icons/tool-icons.json' };
  }

  return null;
}

/**
 * 根据检测到的文件类型校验其内容。
 * 分派到对应的内容校验器。
 * 无法识别类型时返回 null。
 */
export function validateConfigFileContent(
  detection: ConfigFileDetection,
  content: string
): ValidationResult | null {
  switch (detection.type) {
    case 'source':
      return validateSourceConfigContent(content);
    case 'skill':
      return validateSkillContent(content, detection.slug || 'unknown');
    case 'statuses':
      return validateStatusesContent(content);
    case 'labels':
      return validateLabelsContent(content);
    case 'automations':
      return validateAutomationsContent(content, detection.displayFile);
    case 'permissions':
      return validatePermissionsContent(content, detection.displayFile);
    case 'tool-icons':
      return validateToolIconsContent(content);
    default:
      return null;
  }
}
