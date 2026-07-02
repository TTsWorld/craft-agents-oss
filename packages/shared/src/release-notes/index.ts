/**
 * 版本发布说明（Release Notes）工具模块
 *
 * 功能：从打包资源中读取发布说明，并同步到用户目录 ~/.craft-agent/release-notes/。
 * 设计思路与 docs/index.ts 保持一致。
 *
 * 源文件位于 apps/electron/resources/release-notes/*.md。
 */

import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';

// 用户级配置目录：~/.craft-agent
const CONFIG_DIR = join(homedir(), '.craft-agent');
// 发布说明在用户目录下的存放位置
const RELEASE_NOTES_DIR = join(CONFIG_DIR, 'release-notes');

// 是否已经初始化过发布说明目录，防止重复同步
let releaseNotesInitialized = false;

/**
 * 获取发布说明资源目录。
 *
 * 优先使用打包资源路径；如果拿不到（例如开发模式没有设置 CRAFT_BUNDLED_ASSETS_ROOT），
 * 则回退到当前工作目录下的 resources/release-notes。
 */
function getAssetsDir(): string {
  return getBundledAssetsDir('release-notes')
    ?? join(process.cwd(), 'resources', 'release-notes');
}

/**
 * 从资源文件加载打包好的发布说明。
 *
 * 返回一个映射：文件名 → 文件内容。
 * Record<string, string> 是 TS 内置类型，作用类似 Go 的 map[string]string。
 */
function loadBundledReleaseNotes(): Record<string, string> {
  const assetsDir = getAssetsDir();
  const notes: Record<string, string> = {};

  // 优先读取打包资源；如果打包资源目录不存在，
  // 则回退到 ~/.craft-agent/release-notes/。
  // （Docker/远程服务器可能没有设置 CRAFT_BUNDLED_ASSETS_ROOT，
  // 但 initializeReleaseNotes() 会在启动时把文件复制到配置目录）
  let dir = assetsDir;
  if (!existsSync(dir)) {
    dir = RELEASE_NOTES_DIR;
  }

  let files: string[];
  try {
    files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')) : [];
  } catch {
    console.warn(`[release-notes] Could not read release notes dir: ${dir}`);
    return notes;
  }

  for (const filename of files) {
    const filePath = join(dir, filename);
    try {
      notes[filename] = readFileSync(filePath, 'utf-8');
    } catch (error) {
      console.error(`[release-notes] Failed to load ${filename}:`, error);
    }
  }

  return notes;
}

// 缓存加载后的发布说明，避免重复读盘
let _bundledNotes: Record<string, string> | null = null;

/**
 * 获取已加载的发布说明缓存。
 *
 * 首次调用时从磁盘加载，后续直接返回缓存结果。
 */
function getBundledReleaseNotes(): Record<string, string> {
  if (_bundledNotes === null) {
    _bundledNotes = loadBundledReleaseNotes();
  }
  return _bundledNotes;
}

/**
 * 用打包内容初始化发布说明目录。
 *
 * 应在应用启动时调用，通常与 initializeDocs() 一起使用。
 */
export function initializeReleaseNotes(): void {
  if (releaseNotesInitialized) return;
  releaseNotesInitialized = true;

  if (!existsSync(RELEASE_NOTES_DIR)) {
    mkdirSync(RELEASE_NOTES_DIR, { recursive: true });
  }

  const bundledNotes = getBundledReleaseNotes();
  for (const [filename, content] of Object.entries(bundledNotes)) {
    const notePath = join(RELEASE_NOTES_DIR, filename);
    writeFileSync(notePath, content, 'utf-8');
  }

  debug(`[release-notes] Synced ${Object.keys(bundledNotes).length} release notes`);
}

/**
 * 从文件名解析版本号。
 *
 * 例如 "0.4.1.md" → "0.4.1"。
 */
function parseVersion(filename: string): string {
  return filename.replace(/\.md$/, '');
}

/**
 * 比较两个语义化版本号，用于降序排列（最新的排在最前面）。
 *
 * 只比较主版本、次版本、补丁号三段。
 */
function compareSemver(a: string, b: string): number {
  // 把 "x.y.z" 拆成数字数组 [x, y, z]
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    // ?? 是空值合并运算符：如果 pa[i] 为 null/undefined，则取 0。
    // 这里用 pb - pa 实现降序（数值大的版本排在前面）。
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  return 0;
}

/** UI 中最多展示的发布说明条数。 */
const MAX_DISPLAY_NOTES = 10;

/**
 * 发布说明的数据结构定义。
 *
 * TS 的 interface 类似 Go 的 interface：它描述对象必须有哪些字段/方法，
 * 但主要做“结构类型”检查，而不是名义上的实现声明。
 */
export interface ReleaseNote {
  version: string;  // 版本号字符串，如 "0.4.1"
  content: string;  // Markdown 格式的发布说明内容
}

/**
 * 获取发布说明列表。
 *
 * 按版本号从新到旧排序，最多返回 MAX_DISPLAY_NOTES（10）条。
 */
export function getReleaseNotesList(): ReleaseNote[] {
  const notes = getBundledReleaseNotes();
  return Object.entries(notes)
    .map(([filename, content]) => ({
      version: parseVersion(filename),
      content,
    }))
    .sort((a, b) => compareSemver(a.version, b.version))
    .slice(0, MAX_DISPLAY_NOTES);
}

/**
 * 获取最新版本号。
 *
 * 如果没有任何发布说明，返回 undefined。
 */
export function getLatestReleaseVersion(): string | undefined {
  const list = getReleaseNotesList();
  // ?. 是可选链：如果 list[0] 为 undefined，整个表达式返回 undefined，不会抛错。
  return list[0]?.version;
}

/**
 * 把所有发布说明合并成一段 Markdown 字符串。
 *
 * 每个版本之间用水平分隔线 --- 隔开。
 */
export function getCombinedReleaseNotes(): string {
  const list = getReleaseNotesList();
  return list.map(n => {
    // 如果内容不是以一级标题 "# " 开头，自动注入版本标题
    if (!n.content.trimStart().startsWith('# ')) {
      return `# v${n.version}\n\n${n.content}`;
    }
    return n.content;
  }).join('\n\n---\n\n');
}
