/**
 * Skills 存储层
 *
 * 提供 workspace skill 的增删改查（CRUD）。
 * 每个 skill 存放在 {workspace}/skills/{slug}/ 目录下，核心文件是 SKILL.md。
 *
 * Skill 可以理解为 Agent 的“插件式指令”：通过 Markdown 描述任务场景、触发条件、
 * 可用工具权限等信息，让 Claude / Agent 在特定上下文下获得增强能力。
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import type { LoadedSkill, SkillMetadata, SkillSource } from './types.ts';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// Agent Skill 路径（Issue #171）
// ============================================================

/** 全局 agent skill 目录：~/.agents/skills/ */
export const GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/** 项目级 agent skill 的相对目录名 */
export const PROJECT_AGENT_SKILLS_DIR = '.agents/skills';

/**
 * 将 SKILL.md frontmatter 中的 requiredSources 规范化成干净的字符串数组。
 *
 * 支持传入单个字符串或字符串数组；会去除空白并去重。
 * 返回 undefined 表示没有有效的 requiredSources。
 *
 * @param value - frontmatter 中读取到的原始值，类型未知，所以用 unknown
 * @returns 规范化后的 source slug 数组，或 undefined
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  // 如果原始值是字符串，先包成数组；如果是数组就原样使用；否则视为无效。
  const asArray = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;

  if (!asArray) return undefined;

  // 过滤出真正的字符串、trim 去空白、用 Set 去重，再转回数组。
  const normalized = Array.from(new Set(
    asArray
      // 类型谓词：告诉 TS 过滤后的元素一定是 string，类似 Go 的类型断言。
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// ============================================================
// 解析
// ============================================================

/**
 * 解析 SKILL.md 内容，提取 YAML frontmatter 与正文。
 *
 * @param content - SKILL.md 完整文本
 * @returns 包含 metadata 和 body 的对象；解析失败或缺少必填字段时返回 null
 */
function parseSkillFile(content: string): { metadata: SkillMetadata; body: string } | null {
  try {
    // gray-matter 把 Markdown 顶部的 ---...--- YAML 区块拆成 data 和 content。
    const parsed = matter(content);

    // 校验必填字段：name 和 description 必须存在。
    if (!parsed.data.name || !parsed.data.description) {
      return null;
    }

    // 校验并提取可选的 icon 字段。
    // 只接受 emoji 或 URL，拒绝内联 SVG 和相对路径，避免安全和渲染问题。
    const icon = validateIconValue(parsed.data.icon, 'Skills');

    return {
      metadata: {
        // `as string` 是 TS 类型断言：告诉编译器“这里按 string 处理”，类似 Go 的类型断言。
        name: parsed.data.name as string,
        description: parsed.data.description as string,
        globs: parsed.data.globs as string[] | undefined,
        alwaysAllow: parsed.data.alwaysAllow as string[] | undefined,
        icon,
        requiredSources: normalizeRequiredSources(parsed.data.requiredSources),
      },
      body: parsed.content,
    };
  } catch {
    // 解析异常时静默返回 null，上层可以据此判定 skill 无效。
    return null;
  }
}

// ============================================================
// 加载操作
// ============================================================

/**
 * 从单个 skill 目录加载 skill。
 *
 * @param skillsDir - skill 父目录的绝对路径
 * @param slug - skill 目录名，也就是 skill 的标识（slug）
 * @param source - 该 skill 来自哪个层级（global / workspace / project）
 * @returns 加载后的 LoadedSkill，失败返回 null
 */
function loadSkillFromDir(skillsDir: string, slug: string, source: SkillSource): LoadedSkill | null {
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  // 校验目录存在且真的是目录。
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return null;
  }

  // 校验 SKILL.md 存在。
  if (!existsSync(skillFile)) {
    return null;
  }

  // 读取 SKILL.md 内容。
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }

  const parsed = parseSkillFile(content);
  if (!parsed) {
    return null;
  }

  // 组装 LoadedSkill：包含元数据、正文、图标路径、来源等信息。
  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    source,
  };
}

/**
 * 从一个目录加载其下所有 skill。
 *
 * @param skillsDir - skill 父目录的绝对路径
 * @param source - 该目录下 skill 的来源层级
 * @returns skill 数组；目录不存在或读取失败时返回空数组
 */
function loadSkillsFromDir(skillsDir: string, source: SkillSource): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: LoadedSkill[] = [];

  try {
    // withFileTypes: true 返回 Dirent 对象，可直接判断是否为目录。
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = loadSkillFromDir(skillsDir, entry.name, source);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    // 读取 skill 目录出错时忽略，返回已收集的部分。
  }

  return skills;
}

/**
 * 从指定 workspace 加载单个 skill。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @param slug - skill 目录名
 * @returns 加载后的 LoadedSkill，失败返回 null
 */
export function loadSkill(workspaceRoot: string, slug: string): LoadedSkill | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillFromDir(skillsDir, slug, 'workspace');
}

/**
 * 从指定 workspace 加载全部 skill。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @returns skill 数组
 */
export function loadWorkspaceSkills(workspaceRoot: string): LoadedSkill[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillsFromDir(skillsDir, 'workspace');
}

// ── Skill 缓存 ────────────────────────────────────────────────────────
// loadAllSkills 每次调用可能要扫描最多 3 个目录（约 100ms）。
// 在一次会话中 skill 内容很少变化，因此按 (workspaceRoot, projectRoot) 做缓存，
// 并设置 5 分钟 TTL 作为安全兜底。

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const SKILLS_CACHE_TTL = 5 * 60_000; // 5 分钟

/** 清空 skill 缓存；在切换工作目录或 skill 文件发生变更时调用。 */
export function invalidateSkillsCache(): void {
  skillsCache.clear();
}

/**
 * 从所有来源加载 skill（全局、workspace、项目）。
 *
 * 相同 slug 的 skill 会被高优先级来源覆盖。
 * 优先级：global（最低）< workspace < project（最高）
 *
 * 结果按 (workspaceRoot, projectRoot) 缓存；在切换工作目录或 skill 文件变更时，
 * 应调用 invalidateSkillsCache() 使缓存失效。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @param projectRoot - 可选的项目根目录（工作目录），用于加载项目级 skill
 * @returns 合并去重后的 skill 数组
 */
export function loadAllSkills(workspaceRoot: string, projectRoot?: string): LoadedSkill[] {
  // 用字符串拼接生成缓存键，类似 Go 中用 fmt.Sprintf 构造 map key。
  const cacheKey = `${workspaceRoot}::${projectRoot ?? ''}`;
  const now = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return cached.skills;
  }

  // 用 Map 按 slug 聚合，后写入的同名 skill 会覆盖先写入的，从而实现优先级。
  const skillsBySlug = new Map<string, LoadedSkill>();

  // 1. 全局 skill（最低优先级）：~/.agents/skills/
  for (const skill of loadSkillsFromDir(GLOBAL_AGENT_SKILLS_DIR, 'global')) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 2. Workspace skill（中等优先级）
  for (const skill of loadWorkspaceSkills(workspaceRoot)) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 3. 项目级 skill（最高优先级）：{projectRoot}/.agents/skills/
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    for (const skill of loadSkillsFromDir(projectSkillsDir, 'project')) {
      skillsBySlug.set(skill.slug, skill);
    }
  }

  const result = Array.from(skillsBySlug.values());
  skillsCache.set(cacheKey, { skills: result, ts: now });
  return result;
}

/**
 * 按 slug 从所有来源加载单个 skill（project > workspace > global）。
 *
 * 与 loadAllSkills() 不同，这里只读取指定 slug 的目录，是 O(1) 而非 O(N)。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @param slug - 要加载的 skill slug
 * @param projectRoot - 可选的项目根目录，用于加载项目级 skill
 * @returns 加载后的 LoadedSkill，失败返回 null
 */
export function loadSkillBySlug(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  // 最高优先级：项目级 skill
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    const skill = loadSkillFromDir(projectSkillsDir, slug, 'project');
    if (skill) return skill;
  }

  // 中等优先级：workspace skill
  const workspaceSkill = loadSkillFromDir(getWorkspaceSkillsPath(workspaceRoot), slug, 'workspace');
  if (workspaceSkill) return workspaceSkill;

  // 最低优先级：全局 skill
  return loadSkillFromDir(GLOBAL_AGENT_SKILLS_DIR, slug, 'global');
}

/**
 * 获取指定 skill 的图标路径。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @param slug - skill 目录名
 * @returns 图标文件的绝对路径；不存在则返回 null
 */
export function getSkillIconPath(workspaceRoot: string, slug: string): string | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return null;
  }

  return findIconFile(skillDir) || null;
}

// ============================================================
// 删除操作
// ============================================================

/**
 * 从 workspace 删除指定 skill。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @param slug - skill 目录名
 * @returns 删除成功返回 true，失败返回 false
 */
export function deleteSkill(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return false;
  }

  try {
    rmSync(skillDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 检查指定 skill 是否存在于 workspace。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @param slug - skill 目录名
 * @returns 存在返回 true，否则返回 false
 */
export function skillExists(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  return existsSync(skillDir) && existsSync(skillFile);
}

/**
 * 列出 workspace 中所有 skill 的 slug。
 *
 * @param workspaceRoot - workspace 根目录的绝对路径
 * @returns skill slug 数组
 */
export function listSkillSlugs(workspaceRoot: string): string[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => {
        // 只保留包含 SKILL.md 的子目录。
        if (!entry.isDirectory()) return false;
        const skillFile = join(skillsDir, entry.name, 'SKILL.md');
        return existsSync(skillFile);
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ============================================================
// 图标下载（复用共享工具函数）
// ============================================================

/**
 * 从 URL 下载图标并保存到 skill 目录。
 *
 * @param skillDir - skill 目录的绝对路径
 * @param iconUrl - 图标 URL
 * @returns 下载后的图标路径；失败返回 null
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * 判断某个 skill 是否需要下载图标。
 *
 * 当 metadata 中 icon 是 URL 且本地尚未存在图标文件时返回 true。
 *
 * @param skill - 已加载的 skill
 * @returns 需要下载返回 true
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

// 为了方便，重新导出 icon 工具中的 isIconUrl。
export { isIconUrl } from '../utils/icon.ts';
