/**
 * Resource Bundle — 导出/导入逻辑
 *
 * 把 workspace 资源（source、skill、automation）导出为便携的 ResourceBundle，
 * 或将 bundle 导入到目标 workspace。
 *
 * 关键行为：
 * - source 配置会脱敏（剥离密钥、重置认证状态）
 * - 每个资源包含所有非隐藏文件，不只限于已知文件类型
 * - 导入采用“暂存目录 + 原子重命名”，每个资源只触发一次 watcher 事件
 * - source 覆盖会清除已存储的凭证
 * - automation 覆盖会清除历史记录和重试队列
 * - 变更通知依赖已有的 ConfigWatcher，不手动触发事件
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import {
  type BundleFile,
  MAX_BUNDLE_SIZE_BYTES,
  collectDirectoryFiles,
  restoreFiles,
  validateBundleFile,
} from '../utils/bundle-files.ts'
import { getWorkspaceSourcesPath, getWorkspaceSkillsPath } from '../workspaces/storage.ts'
import { loadSourceConfig, getSourcePath } from '../sources/storage.ts'
import { isBuiltinSource } from '../sources/builtin-sources.ts'
import { validateSourceConfig } from '../config/validators.ts'
import { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE } from '../automations/constants.ts'
import { validateAutomationsConfig } from '../automations/validation.ts'
import { generateShortId } from '../automations/resolve-config-path.ts'
import { VALID_EVENTS } from '../automations/schemas.ts'
import { debug } from '../utils/debug.ts'

import type { FolderSourceConfig } from '../sources/types.ts'
import type { AutomationMatcher } from '../automations/types.ts'
import type {
  ResourceBundle,
  SourceBundleEntry,
  SkillBundleEntry,
  AutomationBundleEntry,
  ExportResourcesOptions,
  ExportResult,
  ResourceImportMode,
  ResourceImportResult,
  ImportBucketResult,
  ResourceImportDeps,
} from './types.ts'

// ============================================================
// Source 配置脱敏
// ============================================================

/**
 * 导出时需要从 source 配置中剥离的字段。
 *
 * 运行时状态字段始终移除；
 * 已知的带密钥字段移除时会附加警告。
 */

/** 对 source 配置做脱敏，返回脱敏后的配置和警告信息 */
function sanitizeSourceConfig(config: FolderSourceConfig): { config: FolderSourceConfig; warnings: string[] } {
  const warnings: string[] = []

  // 深拷贝，避免修改原始对象（JSON.parse(JSON.stringify(obj)) 是常见的浅深拷贝折中写法）
  const sanitized: FolderSourceConfig = JSON.parse(JSON.stringify(config))

  // --- 运行时状态：始终移除 ---
  sanitized.isAuthenticated = false
  delete sanitized.connectionError
  delete sanitized.lastTestedAt

  // 判断 source 是否需要认证
  const authType = sanitized.mcp?.authType || sanitized.api?.authType
  if (authType && authType !== 'none') {
    sanitized.connectionStatus = 'needs_auth'
  } else {
    sanitized.connectionStatus = undefined
  }

  // --- 已知的密钥字段：始终移除 ---
  if (sanitized.api?.googleOAuthClientSecret) {
    delete sanitized.api.googleOAuthClientSecret
    warnings.push(`Source '${config.slug}': stripped googleOAuthClientSecret`)
  }

  // --- MCP 环境变量：可能包含 token ---
  if (sanitized.mcp?.env && Object.keys(sanitized.mcp.env).length > 0) {
    delete sanitized.mcp.env
    warnings.push(`Source '${config.slug}': stripped mcp.env (may contain secrets)`)
  }

  // --- Headers：可能包含密钥，移除并警告 ---
  if (sanitized.mcp?.headers && Object.keys(sanitized.mcp.headers).length > 0) {
    delete sanitized.mcp.headers
    warnings.push(`Source '${config.slug}': stripped mcp.headers (may contain auth tokens)`)
  }

  if (sanitized.api?.defaultHeaders && Object.keys(sanitized.api.defaultHeaders).length > 0) {
    delete sanitized.api.defaultHeaders
    warnings.push(`Source '${config.slug}': stripped api.defaultHeaders (may contain auth tokens)`)
  }

  return { config: sanitized, warnings }
}

// ============================================================
// 导出
// ============================================================

/**
 * 把 workspace 资源导出为便携的 ResourceBundle。
 *
 * @param workspaceRootPath - workspace 根目录的绝对路径
 * @param options - 要导出哪些资源
 * @returns bundle 和导出过程中的警告
 */
export function exportResources(
  workspaceRootPath: string,
  options: ExportResourcesOptions,
): ExportResult {
  const warnings: string[] = []
  const bundle: ResourceBundle = {
    version: 1,
    exportedAt: Date.now(),
    resources: {},
  }

  // 尝试读取 workspace 名称，仅用于信息展示
  try {
    const wsConfigPath = join(workspaceRootPath, 'config.json')
    if (existsSync(wsConfigPath)) {
      const wsConfig = JSON.parse(readFileSync(wsConfigPath, 'utf-8'))
      if (wsConfig.name) {
        bundle.sourceWorkspace = wsConfig.name
      }
    }
  } catch {
    // 非致命错误：sourceWorkspace 只是信息字段
  }

  // --- 导出 sources ---
  if (options.sources) {
    bundle.resources.sources = exportSources(workspaceRootPath, options.sources, warnings)
  }

  // --- 导出 skills ---
  if (options.skills) {
    bundle.resources.skills = exportSkills(workspaceRootPath, options.skills, warnings)
  }

  // --- 导出 automations ---
  // 规范化：true 转 'all'，false/undefined 表示跳过
  const automationSelection = options.automations === true ? 'all' : options.automations
  if (automationSelection) {
    bundle.resources.automations = exportAutomations(workspaceRootPath, automationSelection, warnings)
  }

  // 校验总大小
  const bundleJson = JSON.stringify(bundle)
  if (Buffer.byteLength(bundleJson) > MAX_BUNDLE_SIZE_BYTES) {
    warnings.push(`Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES / 1024 / 1024}MB size limit`)
  }

  return { bundle, warnings }
}

/** 导出选定的 sources */
function exportSources(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): SourceBundleEntry[] {
  const entries: SourceBundleEntry[] = []
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath)

  if (!existsSync(sourcesDir)) return entries

  // 确定要导出哪些 slug
  let slugs: string[]
  if (selection === 'all') {
    slugs = readdirSync(sourcesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } else {
    slugs = selection
  }

  for (const slug of slugs) {
    const sourcePath = getSourcePath(workspaceRootPath, slug)
    if (!existsSync(sourcePath)) {
      warnings.push(`Source '${slug}' not found, skipping`)
      continue
    }

    const config = loadSourceConfig(workspaceRootPath, slug)
    if (!config) {
      warnings.push(`Source '${slug}' has invalid config, skipping`)
      continue
    }

    // 脱敏配置
    const { config: sanitizedConfig, warnings: sanitizeWarnings } = sanitizeSourceConfig(config)
    warnings.push(...sanitizeWarnings)

    // 收集除 config.json 外的所有文件（config 作为结构化数据单独传输）
    const files = collectDirectoryFiles(sourcePath, {
      skipFiles: new Set(['config.json']),
    })

    entries.push({
      slug,
      config: sanitizedConfig,
      files,
    })
  }

  return entries
}

/** 导出选定的 skills */
function exportSkills(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): SkillBundleEntry[] {
  const entries: SkillBundleEntry[] = []
  const skillsDir = getWorkspaceSkillsPath(workspaceRootPath)

  if (!existsSync(skillsDir)) return entries

  // 确定要导出哪些 slug
  let slugs: string[]
  if (selection === 'all') {
    slugs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } else {
    slugs = selection
  }

  for (const slug of slugs) {
    const skillDir = join(skillsDir, slug)
    if (!existsSync(skillDir)) {
      warnings.push(`Skill '${slug}' not found, skipping`)
      continue
    }

    // 收集 skill 目录下所有文件
    const files = collectDirectoryFiles(skillDir)

    // 校验必须包含 SKILL.md
    const hasSkillMd = files.some(f => f.relativePath === 'SKILL.md')
    if (!hasSkillMd) {
      warnings.push(`Skill '${slug}' missing SKILL.md, skipping`)
      continue
    }

    entries.push({ slug, files })
  }

  return entries
}

// ============================================================
// 导出：Automations
// ============================================================

/** 已知可能携带密钥的 header key，匹配不区分大小写 */
const SECRET_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /api[-_]?key/i,
]

/** 判断 header key 是否属于密钥类 */
function isSecretHeader(key: string): boolean {
  return SECRET_HEADER_PATTERNS.some(p => p.test(key))
}

/** 若值引用环境变量模板如 $VAR_NAME 或 ${VAR}，则认为是安全的，可以保留 */
function isTemplatedValue(value: string): boolean {
  return /\$[A-Z_]|\$\{/.test(value)
}

/**
 * 对单个 automation matcher 做导出脱敏。
 * 剥离 webhook 的 auth 凭证和已知的认证 header。
 */
function sanitizeAutomationMatcher(
  matcher: AutomationMatcher,
  label: string,
  warnings: string[],
): AutomationMatcher {
  // 深拷贝，避免修改原始对象
  const sanitized: AutomationMatcher = JSON.parse(JSON.stringify(matcher))

  if (!sanitized.actions) return sanitized

  for (const action of sanitized.actions) {
    if (action.type !== 'webhook') continue

    // 完全剥离 auth 字段（bearer token、basic auth 密码等）
    if (action.auth) {
      delete (action as unknown as Record<string, unknown>).auth
      warnings.push(`Automation '${label}': stripped webhook auth credentials`)
    }

    // 剥离已知的认证 header（模板化的安全值除外）
    if (action.headers) {
      const keysToStrip = Object.keys(action.headers).filter(
        key => isSecretHeader(key) && !isTemplatedValue(action.headers![key]!),
      )
      for (const key of keysToStrip) {
        delete action.headers[key]
        warnings.push(`Automation '${label}': stripped webhook header '${key}'`)
      }
      // 若 headers 为空则清理整个字段
      if (Object.keys(action.headers).length === 0) {
        delete (action as unknown as Record<string, unknown>).headers
      }
    }
  }

  return sanitized
}

/** 导出选定的 automations */
function exportAutomations(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): AutomationBundleEntry[] {
  const automationsPath = join(workspaceRootPath, AUTOMATIONS_CONFIG_FILE)

  if (!existsSync(automationsPath)) {
    warnings.push('No automations.json found in workspace')
    return []
  }

  // 读取并走完整校验流程
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(automationsPath, 'utf-8'))
  } catch (err) {
    warnings.push(`Failed to read automations.json: ${err}`)
    return []
  }

  const validation = validateAutomationsConfig(raw)
  if (!validation.valid || !validation.config) {
    warnings.push(`automations.json is invalid: ${validation.errors.join('; ')}`)
    return []
  }

  // 把 { event: matchers[] } 扁平化为独立条目
  const allEntries: AutomationBundleEntry[] = []
  for (const [event, matchers] of Object.entries(validation.config.automations)) {
    if (!matchers) continue
    for (const matcher of matchers) {
      // 若 matcher 没有 id，则回填一个
      const id = matcher.id || generateShortId()
      allEntries.push({
        id,
        name: matcher.name,
        event,
        matcher: { ...matcher, id },
      })
    }
  }

  // 应用选择器过滤
  let selected: AutomationBundleEntry[]
  if (selection === 'all') {
    selected = allEntries
  } else {
    const matched = new Set<string>()
    selected = []
    for (const selector of selection) {
      const matches = allEntries.filter(
        e => e.id === selector || (e.name !== undefined && e.name === selector),
      )
      if (matches.length === 0) {
        warnings.push(`Automation selector '${selector}' did not match any automation`)
      } else if (matches.length > 1 && matches.every(m => m.id !== selector)) {
        // 按名称匹配到多个，警告歧义但仍全部包含
        warnings.push(`Automation name '${selector}' matched ${matches.length} automations`)
      }
      for (const m of matches) {
        if (!matched.has(m.id)) {
          matched.add(m.id)
          selected.push(m)
        }
      }
    }
  }

  // 逐个脱敏
  return selected.map(entry => ({
    ...entry,
    matcher: sanitizeAutomationMatcher(
      entry.matcher,
      entry.name ?? entry.id,
      warnings,
    ),
  }))
}

// ============================================================
// 校验
// ============================================================

/**
 * 校验 ResourceBundle 结构。
 * 返回 { valid, errors }，方便调用方获取诊断信息。
 */
export function validateResourceBundle(bundle: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['Bundle is not an object'] }
  }

  // as 是 TS 的类型断言：告诉编译器“我确信这个对象有 string 键”，类似 Go 的类型断言但只在编译期有效
  const b = bundle as Record<string, unknown>

  if (b.version !== 1) {
    errors.push(`Unsupported bundle version: ${b.version}`)
  }

  if (typeof b.exportedAt !== 'number') {
    errors.push('Missing or invalid exportedAt')
  }

  if (!b.resources || typeof b.resources !== 'object') {
    errors.push('Missing or invalid resources')
    return { valid: false, errors }
  }

  const res = b.resources as Record<string, unknown>

  // 校验 sources
  if (res.sources !== undefined) {
    if (!Array.isArray(res.sources)) {
      errors.push('resources.sources must be an array')
    } else {
      const slugs = new Set<string>()
      for (let i = 0; i < res.sources.length; i++) {
        const entry = res.sources[i]
        const prefix = `sources[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e.slug !== 'string' || !e.slug) {
          errors.push(`${prefix}: missing or invalid slug`)
          continue
        }

        if (slugs.has(e.slug as string)) {
          errors.push(`${prefix}: duplicate slug '${e.slug}'`)
        }
        slugs.add(e.slug as string)

        // 检查是否占用内置/保留 slug
        if (isBuiltinSource(e.slug as string)) {
          errors.push(`${prefix}: '${e.slug}' is a reserved builtin source slug`)
        }

        if (!e.config || typeof e.config !== 'object') {
          errors.push(`${prefix}: missing or invalid config`)
        } else {
          const cfg = e.config as Record<string, unknown>
          if (typeof cfg.slug === 'string' && cfg.slug !== e.slug) {
            errors.push(`${prefix}: config.slug '${cfg.slug}' does not match entry slug '${e.slug}'`)
          }
        }

        if (!Array.isArray(e.files)) {
          errors.push(`${prefix}: files must be an array`)
        } else {
          validateFileEntries(e.files as BundleFile[], prefix, errors)
        }
      }
    }
  }

  // 校验 skills
  if (res.skills !== undefined) {
    if (!Array.isArray(res.skills)) {
      errors.push('resources.skills must be an array')
    } else {
      const slugs = new Set<string>()
      for (let i = 0; i < res.skills.length; i++) {
        const entry = res.skills[i]
        const prefix = `skills[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e.slug !== 'string' || !e.slug) {
          errors.push(`${prefix}: missing or invalid slug`)
          continue
        }

        if (slugs.has(e.slug as string)) {
          errors.push(`${prefix}: duplicate slug '${e.slug}'`)
        }
        slugs.add(e.slug as string)

        if (!Array.isArray(e.files)) {
          errors.push(`${prefix}: files must be an array`)
        } else {
          // 校验必须包含 SKILL.md
          const hasSkillMd = (e.files as BundleFile[]).some(f =>
            typeof f === 'object' && f && (f as BundleFile).relativePath === 'SKILL.md',
          )
          if (!hasSkillMd) {
            errors.push(`${prefix}: missing SKILL.md`)
          }
          validateFileEntries(e.files as BundleFile[], prefix, errors)
        }
      }
    }
  }

  // 校验 automations
  if (res.automations !== undefined) {
    if (!Array.isArray(res.automations)) {
      errors.push('resources.automations must be an array')
    } else {
      const ids = new Set<string>()
      for (let i = 0; i < res.automations.length; i++) {
        const entry = res.automations[i]
        const prefix = `automations[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e.id !== 'string' || !e.id) {
          errors.push(`${prefix}: missing or invalid id`)
          continue
        }

        if (ids.has(e.id as string)) {
          errors.push(`${prefix}: duplicate id '${e.id}'`)
        }
        ids.add(e.id as string)

        if (typeof e.event !== 'string' || !e.event) {
          errors.push(`${prefix}: missing or invalid event`)
        } else if (!VALID_EVENTS.includes(e.event as string)) {
          errors.push(`${prefix}: unknown event type '${e.event}'`)
        }

        if (!e.matcher || typeof e.matcher !== 'object') {
          errors.push(`${prefix}: missing or invalid matcher`)
        } else {
          const m = e.matcher as Record<string, unknown>
          if (!Array.isArray(m.actions) || m.actions.length === 0) {
            errors.push(`${prefix}: matcher must have at least one action`)
          }
        }
      }
    }
  }

  // 校验 bundle 总大小
  try {
    const size = Buffer.byteLength(JSON.stringify(bundle))
    if (size > MAX_BUNDLE_SIZE_BYTES) {
      errors.push(`Bundle size ${size} exceeds max ${MAX_BUNDLE_SIZE_BYTES}`)
    }
  } catch {
    errors.push('Bundle is not serializable')
  }

  return { valid: errors.length === 0, errors }
}

/** 校验 BundleFile 数组：检查重复路径和文件格式 */
function validateFileEntries(files: BundleFile[], prefix: string, errors: string[]): void {
  const paths = new Set<string>()

  for (let j = 0; j < files.length; j++) {
    const file = files[j]
    if (!file || typeof file !== 'object') {
      errors.push(`${prefix}.files[${j}]: not an object`)
      continue
    }

    // 检查重复路径
    if (paths.has(file.relativePath)) {
      errors.push(`${prefix}.files[${j}]: duplicate path '${file.relativePath}'`)
    }
    paths.add(file.relativePath)

    const fileError = validateBundleFile(file)
    if (fileError) {
      errors.push(`${prefix}.files[${j}]: ${fileError}`)
    }
  }
}

// ============================================================
// 导入
// ============================================================

/**
 * 把 ResourceBundle 导入到目标 workspace。
 *
 * 每个资源使用“暂存目录 + 原子重命名”，减少 watcher 抖动，
 * 并确保覆盖时是真正的替换。
 *
 * @param workspaceRootPath - 目标 workspace 根目录的绝对路径
 * @param bundle - 已校验或待校验的 ResourceBundle
 * @param mode - 'skip'（保留已有）或 'overwrite'（替换）
 * @param deps - 注入的依赖，用于凭证清理
 */
export async function importResources(
  workspaceRootPath: string,
  bundle: ResourceBundle,
  mode: ResourceImportMode,
  deps: ResourceImportDeps,
): Promise<ResourceImportResult> {
  // 先校验 bundle
  const validation = validateResourceBundle(bundle)
  if (!validation.valid) {
    const errorMsg = `Invalid bundle: ${validation.errors.join('; ')}`
    const failedBucket = { imported: [], skipped: [], failed: [{ id: '*', error: errorMsg }], warnings: [] }
    return {
      sources: { ...failedBucket },
      skills: { ...failedBucket },
      automations: { ...failedBucket },
    }
  }

  // workspaceId 这里直接用目录名；调用方应保证路径唯一对应一个 workspace
  const workspaceId = basename(workspaceRootPath)

  // 分别导入三类资源
  const sourcesResult = bundle.resources.sources
    ? await importSources(workspaceRootPath, workspaceId, bundle.resources.sources, mode, deps)
    : emptyBucketResult()

  const skillsResult = bundle.resources.skills
    ? importSkills(workspaceRootPath, bundle.resources.skills, mode)
    : emptyBucketResult()

  const automationsResult = bundle.resources.automations?.length
    ? importAutomations(workspaceRootPath, bundle.resources.automations, mode)
    : emptyBucketResult()

  return {
    sources: sourcesResult,
    skills: skillsResult,
    automations: automationsResult,
  }
}

/** 返回一个空的 ImportBucketResult */
function emptyBucketResult(): ImportBucketResult {
  return { imported: [], skipped: [], failed: [], warnings: [] }
}

// ============================================================
// 导入：Sources
// ============================================================

/** 导入 source 列表 */
async function importSources(
  workspaceRootPath: string,
  workspaceId: string,
  entries: SourceBundleEntry[],
  mode: ResourceImportMode,
  deps: ResourceImportDeps,
): Promise<ImportBucketResult> {
  const result = emptyBucketResult()
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath)

  if (!existsSync(sourcesDir)) {
    mkdirSync(sourcesDir, { recursive: true })
  }

  for (const entry of entries) {
    try {
      // 保留 slug 不能与内置 source 冲突
      if (isBuiltinSource(entry.slug)) {
        result.failed.push({ id: entry.slug, error: 'Cannot import builtin source slug' })
        continue
      }

      const targetDir = getSourcePath(workspaceRootPath, entry.slug)
      const exists = existsSync(targetDir)

      if (exists && mode === 'skip') {
        result.skipped.push(entry.slug)
        continue
      }

      // 暂存：在临时目录里构建完整目录
      const tmpDir = join(sourcesDir, `.tmp-${entry.slug}-${randomUUID().slice(0, 8)}`)
      mkdirSync(tmpDir, { recursive: true })

      try {
        // 写入脱敏后的 config.json
        writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(entry.config, null, 2))

        // 恢复其余文件
        restoreFiles(tmpDir, entry.files)

        // 校验：配置应该能被正常加载
        const validation = validateSourceConfig(entry.config)
        if (!validation.valid) {
          const msgs = validation.errors.map(e => `${e.path}: ${e.message}`).join(', ')
          result.failed.push({ id: entry.slug, error: `Invalid source config: ${msgs}` })
          rmSync(tmpDir, { recursive: true })
          continue
        }

        // 覆盖时：清除凭证 + 删除旧目录
        if (exists) {
          // 清除该 source 下的所有凭证类型
          try {
            await deps.clearSourceCredentials(workspaceId, entry.slug)
          } catch (err) {
            result.warnings.push(`Source '${entry.slug}': failed to clear credentials: ${err}`)
          }
          rmSync(targetDir, { recursive: true })
        }

        // 原子替换：重命名临时目录为目标目录
        renameSync(tmpDir, targetDir)
        result.imported.push(entry.slug)
      } catch (err) {
        // 失败时清理临时目录
        if (existsSync(tmpDir)) {
          rmSync(tmpDir, { recursive: true })
        }
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: entry.slug, error: message })
    }
  }

  return result
}

// ============================================================
// 导入：Skills
// ============================================================

/** 导入 skill 列表 */
function importSkills(
  workspaceRootPath: string,
  entries: SkillBundleEntry[],
  mode: ResourceImportMode,
): ImportBucketResult {
  const result = emptyBucketResult()
  const skillsDir = getWorkspaceSkillsPath(workspaceRootPath)

  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }

  for (const entry of entries) {
    try {
      const targetDir = join(skillsDir, entry.slug)
      const exists = existsSync(targetDir)

      if (exists && mode === 'skip') {
        result.skipped.push(entry.slug)
        continue
      }

      // 暂存：在临时目录里构建完整目录
      const tmpDir = join(skillsDir, `.tmp-${entry.slug}-${randomUUID().slice(0, 8)}`)
      mkdirSync(tmpDir, { recursive: true })

      try {
        // 恢复所有文件
        restoreFiles(tmpDir, entry.files)

        // 校验：SKILL.md 必须存在
        if (!existsSync(join(tmpDir, 'SKILL.md'))) {
          result.failed.push({ id: entry.slug, error: 'SKILL.md missing after restore' })
          rmSync(tmpDir, { recursive: true })
          continue
        }

        // 覆盖时：删除旧目录
        if (exists) {
          rmSync(targetDir, { recursive: true })
        }

        // 原子替换：重命名临时目录为目标目录
        renameSync(tmpDir, targetDir)
        result.imported.push(entry.slug)
      } catch (err) {
        // 失败时清理临时目录
        if (existsSync(tmpDir)) {
          rmSync(tmpDir, { recursive: true })
        }
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: entry.slug, error: message })
    }
  }

  return result
}

// ============================================================
// 导入：Automations
// ============================================================

/** 获取 automation 条目的显示标签（优先 name，否则用 ID） */
function automationLabel(entry: AutomationBundleEntry): string {
  return entry.name ?? entry.id
}

/**
 * 按 ID 在所有事件数组中查找 matcher。
 * 找到返回 { event, index }，否则返回 undefined。
 */
function findMatcherById(
  automations: Record<string, AutomationMatcher[]>,
  id: string,
): { event: string; index: number } | undefined {
  for (const [event, matchers] of Object.entries(automations)) {
    for (let i = 0; i < matchers.length; i++) {
      // 可选链 matchers[i]?.id：若 matchers[i] 为 undefined 则不会抛错
      if (matchers[i]?.id === id) return { event, index: i }
    }
  }
  return undefined
}

/**
 * 过滤 JSONL 文件，移除 matcherId/automationId 命中待清除集合的记录。
 * 用于覆盖时清理历史记录和重试队列。
 */
function filterJsonlByMatcherIds(filePath: string, idsToRemove: Set<string>): void {
  if (!existsSync(filePath) || idsToRemove.size === 0) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n')
    const kept: string[] = []

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.matcherId && idsToRemove.has(entry.matcherId)) continue
        // 历史记录条目使用 automationId
        if (entry.automationId && idsToRemove.has(entry.automationId)) continue
        kept.push(line)
      } catch {
        // 无法解析的行保留，避免静默丢数据
        kept.push(line)
      }
    }

    writeFileSync(filePath, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf-8')
  } catch {
    // 非关键：清理失败不应阻塞导入
  }
}

/** 导入 automation 列表 */
function importAutomations(
  workspaceRootPath: string,
  entries: AutomationBundleEntry[],
  mode: ResourceImportMode,
): ImportBucketResult {
  const result = emptyBucketResult()
  const configPath = join(workspaceRootPath, AUTOMATIONS_CONFIG_FILE)

  // 读取已有配置（若存在）
  let existingConfig: { version?: number; automations: Record<string, AutomationMatcher[]> }

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      const validation = validateAutomationsConfig(raw)
      if (validation.valid && validation.config) {
        existingConfig = {
          version: (raw as Record<string, unknown>).version as number | undefined,
          automations: validation.config.automations as Record<string, AutomationMatcher[]>,
        }
      } else if (mode === 'overwrite') {
        // 已有配置无效但处于覆盖模式，直接重建
        result.warnings.push('Existing automations.json is invalid, starting fresh in overwrite mode')
        existingConfig = { version: 2, automations: {} }
      } else {
        // 跳过模式 + 已有配置无效，无法安全合并
        const errorMsg = `Cannot merge into invalid existing automations.json: ${validation.errors.join('; ')}`
        for (const entry of entries) {
          result.failed.push({ id: automationLabel(entry), error: errorMsg })
        }
        return result
      }
    } catch (err) {
      if (mode === 'overwrite') {
        result.warnings.push(`Existing automations.json is unreadable (${err}), starting fresh in overwrite mode`)
        existingConfig = { version: 2, automations: {} }
      } else {
        const errorMsg = `Cannot read existing automations.json: ${err}`
        for (const entry of entries) {
          result.failed.push({ id: automationLabel(entry), error: errorMsg })
        }
        return result
      }
    }
  } else {
    // 没有已有文件，新建
    existingConfig = { version: 2, automations: {} }
  }

  const overwrittenIds = new Set<string>()

  // 合并条目
  for (const entry of entries) {
    // 若 ID 缺失则回填
    const id = entry.id || generateShortId()
    const matcher: AutomationMatcher = { ...entry.matcher, id }
    const label = entry.name ?? id

    // 检查是否已存在同 ID 的 automation
    const existing = findMatcherById(existingConfig.automations, id)

    if (existing) {
      if (mode === 'skip') {
        result.skipped.push(label)
        continue
      }
      // 覆盖：在原位置删除旧 matcher，再插入新 matcher
      existingConfig.automations[existing.event]!.splice(existing.index, 1)
      // 若该事件下已空，则清理空数组
      if (existingConfig.automations[existing.event]!.length === 0) {
        delete existingConfig.automations[existing.event]
      }
      overwrittenIds.add(id)
    }

    // 插入到目标事件的 matcher 数组
    if (!existingConfig.automations[entry.event]) {
      existingConfig.automations[entry.event] = []
    }
    existingConfig.automations[entry.event]!.push(matcher)
    result.imported.push(label)
  }

  // 校验合并后的完整配置（schema + 语义：正则、cron、时区、条件等）
  const mergedValidation = validateAutomationsConfig({
    version: existingConfig.version,
    automations: existingConfig.automations,
  })

  if (!mergedValidation.valid) {
    // 合并结果无效，拒绝整个导入
    const errorMsg = `Merged automations config is invalid: ${mergedValidation.errors.join('; ')}`
    result.imported = []
    result.skipped = []
    for (const entry of entries) {
      result.failed.push({ id: automationLabel(entry), error: errorMsg })
    }
    return result
  }

  // 原子写入：临时文件 + 重命名
  try {
    const configObj = {
      version: existingConfig.version ?? 2,
      automations: existingConfig.automations,
    }
    const tmpPath = configPath + `.tmp-${randomUUID().slice(0, 8)}`
    writeFileSync(tmpPath, JSON.stringify(configObj, null, 2) + '\n', 'utf-8')
    renameSync(tmpPath, configPath)
  } catch (err) {
    const errorMsg = `Failed to write automations.json: ${err}`
    result.imported = []
    for (const entry of entries) {
      result.failed.push({ id: automationLabel(entry), error: errorMsg })
    }
    return result
  }

  // 对覆盖的 matcher ID，清理历史记录和重试队列中的相关条目
  if (overwrittenIds.size > 0) {
    const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE)
    const retryPath = join(workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE)
    filterJsonlByMatcherIds(historyPath, overwrittenIds)
    filterJsonlByMatcherIds(retryPath, overwrittenIds)

    result.warnings.push(`Cleared history/retry entries for ${overwrittenIds.size} overwritten automation(s)`)
  }

  return result
}
