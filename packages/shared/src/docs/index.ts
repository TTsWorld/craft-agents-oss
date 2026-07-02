/**
 * 文档工具集
 *
 * 提供对内建文档的访问。Claude 在执行配置任务（如 source、agent、permissions 等）时可以引用这些文档。
 *
 * 文档会同步到 ~/.craft-agent/docs/，原始内容位于 apps/electron/resources/docs/*.md，方便编辑。
 */

// Node.js 内置模块：path 处理路径，os 获取用户主目录，fs 读写文件。
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
// 项目内共享工具：getBundledAssetsDir 解析资源目录，debug 输出调试日志。
import { getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';

// ~/.craft-agent 配置目录；~ 用 os.homedir() 解析为实际路径。
const CONFIG_DIR = join(homedir(), '.craft-agent');
// 文档最终落盘目录：~/.craft-agent/docs
const DOCS_DIR = join(CONFIG_DIR, 'docs');

// 标记本进程是否已经初始化过文档。防止热重载（hot reload）时重复写入。
let docsInitialized = false;

// 使用共享的资源解析器定位内建文档目录。
// 兼容三种环境：开发（resources/docs）、打包（dist/resources/docs）、Electron 安装包（启动时通过 setBundledAssetsRoot 设置根目录）。
function getAssetsDir(): string {
  return getBundledAssetsDir('docs')
    // 兜底：开发目录。若文件不存在，后续读取会优雅降级为空。
    ?? join(process.cwd(), 'resources', 'docs');
}

/**
 * 从资源目录加载内建文档。
 * 模块初始化时调用一次；文件不存在时返回空字符串（优雅降级）。
 */
function loadBundledDocs(): Record<string, string> {
  const assetsDir = getAssetsDir();
  // Record<string, string> 类似 Go 的 map[string]string：文件名 -> 文件内容。
  const docs: Record<string, string> = {};

  // 自动发现资源目录下的所有文件：不硬编码列表，丢进 resources/docs/ 的文件会自动同步。
  let files: string[];
  try {
    files = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  } catch {
    console.warn(`[docs] Could not read assets dir: ${assetsDir}`);
    return docs;
  }

  for (const filename of files) {
    const filePath = join(assetsDir, filename);
    try {
      docs[filename] = readFileSync(filePath, 'utf-8');
    } catch (error) {
      console.error(`[docs] Failed to load ${filename}:`, error);
    }
  }

  return docs;
}

// 内建文档的懒加载缓存。
// 重要：不能在模块初始化时立即加载，因为此时 setBundledAssetsRoot() 还没被调用， eager load 会导致新安装时读到空文档。
let _bundledDocs: Record<string, string> | null = null;

/**
 * 获取内建文档内容，首次访问时才真正加载（懒加载）。
 * 确保在 setBundledAssetsRoot() 调用完成后再读取资源。
 */
function getBundledDocs(): Record<string, string> {
  if (_bundledDocs === null) {
    _bundledDocs = loadBundledDocs();
  }
  return _bundledDocs;
}

/**
 * 获取文档目录的完整路径。
 */
export function getDocsDir(): string {
  return DOCS_DIR;
}

/**
 * 获取某个文档文件的完整路径。
 * @param filename 文档文件名，例如 "sources.md"
 */
export function getDocPath(filename: string): string {
  return join(DOCS_DIR, filename);
}

// 仅用于提示词或展示文本的应用根路径。
// 重要：这是给人看的固定字符串，不代表真实运行实例路径；不要用它做实际文件读写。
// 运行时路径请使用 config/paths.ts 里的 CONFIG_DIR。
export const APP_ROOT = '~/.craft-agent';

/**
 * 文档引用常量集合，用于错误提示和工具描述。
 * 统一从这里取路径，避免在多处硬编码导致不一致。
 * `as const` 让 TS 推断出最窄的只读字面量类型，类似 Go 的 const 字符串。
 */
export const DOC_REFS = {
  appRoot: APP_ROOT,
  sources: `${APP_ROOT}/docs/sources.md`,
  permissions: `${APP_ROOT}/docs/permissions.md`,
  skills: `${APP_ROOT}/docs/skills.md`,
  themes: `${APP_ROOT}/docs/themes.md`,
  statuses: `${APP_ROOT}/docs/statuses.md`,
  labels: `${APP_ROOT}/docs/labels.md`,
  toolIcons: `${APP_ROOT}/docs/tool-icons.md`,
  automations: `${APP_ROOT}/docs/automations.md`,
  hooks: `${APP_ROOT}/docs/automations.md`,
  tasks: `${APP_ROOT}/docs/automations.md`,
  mermaid: `${APP_ROOT}/docs/mermaid.md`,
  dataTables: `${APP_ROOT}/docs/data-tables.md`,
  htmlPreview: `${APP_ROOT}/docs/html-preview.md`,
  pdfPreview: `${APP_ROOT}/docs/pdf-preview.md`,
  imagePreview: `${APP_ROOT}/docs/image-preview.md`,
  markdownPreview: `${APP_ROOT}/docs/markdown-preview.md`,
  llmTool: `${APP_ROOT}/docs/llm-tool.md`,
  browserTools: `${APP_ROOT}/docs/browser-tools.md`,
  craftCli: `${APP_ROOT}/docs/craft-cli.md`,
  docsDir: `${APP_ROOT}/docs/`,
} as const;

/**
 * 检查文档目录是否存在。
 */
export function docsExist(): boolean {
  return existsSync(DOCS_DIR);
}

/**
 * 列出已同步到本地的 Markdown 文档文件名。
 */
export function listDocs(): string[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
}

/**
 * 用内建文档初始化本地文档目录。
 * 每次启动都会全量写入，保证 debug 和 release 模式行为一致，始终与当前版本同步。
 */
export function initializeDocs(): void {
  // 如果本进程已初始化过，直接跳过（防止热重载重复写入）。
  if (docsInitialized) {
    return;
  }
  docsInitialized = true;

  if (!existsSync(DOCS_DIR)) {
    // recursive: true 表示递归创建父目录，类似 mkdir -p。
    mkdirSync(DOCS_DIR, { recursive: true });
  }

  // 懒加载内建文档（确保 setBundledAssetsRoot 已执行）。
  const bundledDocs = getBundledDocs();

  // 启动时始终将内建文档写回磁盘。
  // 这样 debug 和 release 行为一致：文档始终与当前运行版本保持一致。
  for (const [filename, content] of Object.entries(bundledDocs)) {
    const docPath = join(DOCS_DIR, filename);
    writeFileSync(docPath, content, 'utf-8');
  }

  debug(`[docs] Synced ${Object.keys(bundledDocs).length} docs`);
}

// 将懒加载 getter 导出，供外部在需要时读取原始内建文档内容。
export { getBundledDocs };

// 从 source-guides.ts 重新导出解析工具（内建 guide 已移除，只剩解析逻辑）。
// `type Xxx` 表示只导出类型，不会生成运行时导入；类似 Go 只暴露接口定义。
export {
  parseSourceGuide,
  getSourceGuide,
  getSourceGuideForDomain,
  getSourceKnowledge,
  extractDomainFromSource,
  extractDomainFromUrl,
  type ParsedSourceGuide,
  type SourceGuideFrontmatter,
} from './source-guides.ts';

// 从 doc-links.ts 重新导出文档链接，供 UI 帮助气泡使用。
export {
  getDocUrl,
  getDocInfo,
  DOCS,
  type DocFeature,
  type DocInfo,
} from './doc-links.ts';
