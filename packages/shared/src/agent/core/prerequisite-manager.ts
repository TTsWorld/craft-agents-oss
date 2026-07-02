/**
 * PrerequisiteManager - 前置阅读系统
 *
 * 【中文学习注释 - 文件级】
 * 本模块管理 agent 启动 / 工具调用前的“前置阅读条件”。
 * 核心思想：在某些工具被允许执行前，强制 LLM 先读某个文档（比如 source 的 guide.md、
 * skill 的 SKILL.md、内置 browser 工具的 browser-tools.md），否则就用 block 拦下来。
 *
 * 类比 Go：它像一个 HTTP 中间件里的前置校验器——请求进来先检查“是否读过某文件”，
 * 没读就返回错误让客户端重来。
 *
 * 关键背景（Agent 概念）：
 * - “compaction（上下文压缩）”：LLM 上下文窗口满了之后会被压缩，压缩后 LLM 就“忘了”
 *   之前读过的内容，所以 read 状态需要 reset，重新强制读一次。
 * - “source”：外部能力来源（MCP server / API），通常带有 guide.md 说明文档。
 * - “skill”：可复用的提示词包，带 SKILL.md 入口文件。
 *
 * 核心职责：
 * - 追踪哪些文件已通过 Read 工具被读过
 * - 在工具执行前检查前置条件（例如 source 的 guide.md）
 * - 在上下文压缩（compaction）时重置状态
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { expandPath } from './path-processor.ts';
import { getBrowserToolEnabled } from '../../config/storage.ts';

// ============================================================
// 类型定义
// ============================================================

/**
 * 单条前置条件规则。
 *
 * 【TS 学习点 - interface】：TS 的 interface 类似 Go 的 struct + 行为契约，但只描述“形状”，
 * 不包含实现。这里定义了规则的数据结构，实现由各规则字面量提供。
 */
export interface PrerequisiteRule {
  /** 匹配需要校验前置条件的工具名（返回 true 表示该工具受本规则约束） */
  toolMatcher: (toolName: string) => boolean;
  /** 为匹配到的工具解析出“必须先读”的文件绝对路径；返回 null 表示跳过本规则（例如 guide.md 不存在） */
  resolveRequiredPath: (toolName: string, workspaceRootPath: string) => string | null;
  /** 拦截提示信息模板，{filePath} 会被替换为实际需要读取的路径 */
  blockMessage: string;
  /** 若为 true，则严格拦截：永远 block 直到文件被读过，不享受“达到最大拦截次数后放行”的兜底 */
  strict?: boolean;
}

/** 前置条件检查结果：allowed=true 放行；allowed=false 时 blockReason 给 LLM 看 */
export interface PrerequisiteCheckResult {
  allowed: boolean;
  blockReason?: string;
}

/** PrerequisiteManager 的构造配置 */
export interface PrerequisiteManagerConfig {
  workspaceRootPath: string;
  /** 可选的调试日志回调，类似 Go 里的 log.Printf，但通过依赖注入避免硬编码 logger */
  onDebug?: (message: string) => void;
}

// ============================================================
// 常量
// ============================================================

/** 免检的 source slug 集合（这些是内部 source，没有 guide.md 也不强制读） */
const EXEMPT_SLUGS = new Set(['session', 'craft-agents-docs']);

/** 内置 browser 工具启用前必须读的全局文档路径：~/.craft-agent/docs/browser-tools.md */
const BROWSER_TOOLS_DOC_PATH = resolve(join(homedir(), '.craft-agent', 'docs', 'browser-tools.md'));

// ============================================================
// 规则
// ============================================================

/**
 * 静态规则集合。每条规则声明：
 * - 适用于哪些工具（toolMatcher）
 * - 必须先读哪个文件（resolveRequiredPath）
 * - 拦截时给 LLM 的提示（blockMessage）
 *
 * 【TS 学习点 - 数组字面量类型】：`PrerequisiteRule[]` 表示“元素都是 PrerequisiteRule 的数组”，
 * 相当于 Go 里的 `[]PrerequisiteRule`。
 */
const RULES: PrerequisiteRule[] = [
  // MCP source 工具：工具名形如 mcp__{slug}__{tool}
  {
    toolMatcher: (toolName: string) => {
      if (!toolName.startsWith('mcp__')) return false;
      const parts = toolName.split('__');
      if (parts.length < 3) return false;
      // 【TS 学习点 - 非空断言 !】：parts[1] 类型是 string | undefined，
      // 加 `!` 告诉编译器“我确定它不是 undefined”，等同于 Go 里直接取值但跳过检查。
      const slug = parts[1]!;
      return !EXEMPT_SLUGS.has(slug);
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const parts = toolName.split('__');
      const slug = parts[1]!;
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Please read the file at {filePath} first, then retry.',
  },

  // API source 工具：工具名形如 api_{slug}
  {
    toolMatcher: (toolName: string) => {
      return toolName.startsWith('api_');
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const slug = toolName.slice(4); // 去掉 'api_' 前缀
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Please read the file at {filePath} first, then retry.',
  },

  // 内置 browser 工具：要求先读 browser-tools.md。
  // 仅匹配 session 作用域的工具（不匹配外部 MCP 浏览器工具如 mcp__playwright__*），
  // 且在内置 browser 工具被禁用时整体跳过。
  {
    toolMatcher: (toolName: string) =>
      getBrowserToolEnabled() &&
      (toolName === 'browser_tool' || toolName === 'mcp__session__browser_tool'),
    resolveRequiredPath: () => {
      return existsSync(BROWSER_TOOLS_DOC_PATH) ? BROWSER_TOOLS_DOC_PATH : null;
    },
    blockMessage:
      'You must read the browser tools guide before using browser automation. Please read the file at {filePath} first, then retry.',
    strict: true,
  },
];

// ============================================================
// PrerequisiteManager 实现
// ============================================================

/**
 * PrerequisiteManager：维护“已读文件集合 + 待读 skill 集合”，并在工具调用前检查前置条件。
 *
 * 【TS 学习点 - class vs Go】：
 * - TS 的 class 字段直接在类体里声明（如 `private readFiles: Set<string>`），相当于 Go struct 字段。
 * - `private` 是编译期访问控制，运行时不强制（不像 Go 的小写字段跨包不可见）。
 * - `static readonly` 类似 Go 的常量，但 TS 用编译期常量。
 */
export class PrerequisiteManager {
  /** 对同一条前置条件最多拦截次数：超过就兜底放行，避免 LLM 死循环卡死 */
  private static readonly MAX_REJECTIONS = 1;

  /** 已经读过的文件（绝对路径）集合，用 Set 做 O(1) 查询 */
  private readFiles: Set<string> = new Set();
  /** 每个“必须先读路径”被拦截的次数计数，用于兜底放行 */
  private rejectionCounts: Map<string, number> = new Map();
  /** 动态注册的、必须先读的 skill SKILL.md 路径集合 */
  private pendingSkillPaths: Set<string> = new Set();
  private workspaceRootPath: string;
  private onDebug?: (message: string) => void;

  constructor(config: PrerequisiteManagerConfig) {
    this.workspaceRootPath = config.workspaceRootPath;
    this.onDebug = config.onDebug;
  }

  /**
   * 把若干 skill 的 SKILL.md 注册为前置阅读条件。
   * 在这些文件被 Read 工具读过之前，所有非 Read 工具调用都会被拦截。
   *
   * 【TS 学习点 - for...of】：遍历可迭代对象，类似 Go 的 `for _, p := range paths`。
   */
  registerSkillPrerequisites(paths: string[]): void {
    for (const path of paths) {
      const expanded = expandPath(path);
      this.pendingSkillPaths.add(expanded);
      // 【TS 学习点 - 可选链 ?.】：this.onDebug 可能是 undefined，
      // `this.onDebug?.(...` 表示“如果存在就调用，否则什么也不做”。Go 里需要先 if nil 判断。
      this.onDebug?.(`Prerequisite: registered skill prerequisite ${expanded}`);
    }
  }

  /**
   * 检查某次工具调用是否满足前置条件。
   * 遍历规则集合，逐条匹配；对必须先读的文件检查是否已读。
   * 同一条路径被拦截达到 MAX_REJECTIONS 次后会兜底放行（避免死循环）。
   *
   * 返回值：{ allowed: true } 放行；{ allowed: false, blockReason } 拦截。
   */
  checkPrerequisites(toolName: string): PrerequisiteCheckResult {
    // 先检查动态注册的 skill 前置条件
    const skillResult = this.checkSkillPrerequisites(toolName);
    if (!skillResult.allowed) return skillResult;

    for (const rule of RULES) {
      if (!rule.toolMatcher(toolName)) continue;

      const requiredPath = rule.resolveRequiredPath(toolName, this.workspaceRootPath);
      if (!requiredPath) continue; // 没有 guide.md，跳过

      if (!this.readFiles.has(requiredPath)) {
        // 【TS 学习点 - Map.get + ??】：Map.get 返回 `number | undefined`，
        // `?? 0` 表示“如果是 null/undefined 就用 0”——空值合并运算符。
        const count = (this.rejectionCounts.get(requiredPath) ?? 0) + 1;
        this.rejectionCounts.set(requiredPath, count);

        const blockReason = rule.blockMessage.replace('{filePath}', requiredPath);

        if (rule.strict) {
          this.onDebug?.(`Prerequisite blocked (strict): ${toolName} requires ${requiredPath}`);
          return { allowed: false, blockReason };
        }

        if (count <= PrerequisiteManager.MAX_REJECTIONS) {
          this.onDebug?.(`Prerequisite blocked (${count}/${PrerequisiteManager.MAX_REJECTIONS}): ${toolName} requires ${requiredPath}`);
          return { allowed: false, blockReason };
        }
        // 超过最大拦截次数——兜底放行
        this.onDebug?.(`Prerequisite: allowing ${toolName} after ${count} rejections (max reached)`);
      }
    }

    return { allowed: true };
  }

  /**
   * 检查动态 skill 前置条件。
   * 如果存在待读 skill 路径，且当前工具不是“针对这些路径的 Read”，就拦截。
   */
  private checkSkillPrerequisites(toolName: string): PrerequisiteCheckResult {
    if (this.pendingSkillPaths.size === 0) return { allowed: true };

    // 放行 Read 工具——trackReadTool 会在工具执行后清除对应的前置条件
    if (toolName === 'Read') return { allowed: true };

    // 【TS 学习点 - 展开运算符 ...】：`[...this.pendingSkillPaths]` 把 Set 转成数组，
    // 相当于 Go 里把 map keys 收集成 slice。`.join(', ')` 再拼成字符串。
    const pendingList = [...this.pendingSkillPaths].join(', ');
    const key = `skill:${pendingList}`;
    const count = (this.rejectionCounts.get(key) ?? 0) + 1;
    this.rejectionCounts.set(key, count);

    if (count <= PrerequisiteManager.MAX_REJECTIONS) {
      const blockReason = `You must read the skill instruction files before proceeding. Use Read or \`cat\` via Bash to read: ${pendingList}`;
      this.onDebug?.(`Skill prerequisite blocked (${count}/${PrerequisiteManager.MAX_REJECTIONS}): ${toolName} — pending: ${pendingList}`);
      return { allowed: false, blockReason };
    }

    // 超过最大拦截次数——放行并清空待读集合
    this.onDebug?.(`Skill prerequisite: allowing ${toolName} after ${count} rejections (max reached)`);
    this.pendingSkillPaths.clear();
    return { allowed: true };
  }

  /**
   * 记录一次 Read 工具调用。
   * 从工具入参里取出 file_path，做路径展开后加入“已读集合”，
   * 同时清掉匹配的待读 skill 路径。
   */
  trackReadTool(toolInput: Record<string, unknown>): void {
    // 【TS 学习点 - as 类型断言】：把 unknown 强制当作 string 用，
    // 相当于 Go 的 type assertion (v.(string))，但 TS 的 as 不做运行时检查。
    const filePath = (toolInput.file_path as string) || (toolInput.path as string);
    if (!filePath) return;

    const expanded = expandPath(filePath);
    this.readFiles.add(expanded);

    // 如果读的恰好是某个待读 skill 文件，就把它从待读集合里移除
    if (this.pendingSkillPaths.has(expanded)) {
      this.pendingSkillPaths.delete(expanded);
      this.onDebug?.(`Prerequisite: cleared skill prerequisite ${expanded}`);
    }

    this.onDebug?.(`Prerequisite: tracked read of ${expanded}`);
  }

  /**
   * 检查一条 Bash 命令是否在读某个待读 skill 文件。
   * 如果命令里包含待读路径，就清掉对应前置条件并返回 true。
   * 由 pre-tool-use 流水线调用，用来放行“用 cat 读 skill 文件”这类操作。
   */
  trackBashSkillRead(input: Record<string, unknown>): boolean {
    const command = input.command as string;
    if (!command || this.pendingSkillPaths.size === 0) return false;

    let matched = false;
    for (const path of this.pendingSkillPaths) {
      if (command.includes(path)) {
        this.pendingSkillPaths.delete(path);
        this.readFiles.add(path);
        this.onDebug?.(`Prerequisite: cleared skill prerequisite via Bash: ${path}`);
        matched = true;
      }
    }
    return matched;
  }

  /**
   * 重置已读状态。在上下文压缩（compaction）时调用：因为压缩后 LLM 已经“忘了”
   * 之前读过的 guide.md 内容，必须重新强制读一次。
   * 同时清空待读 skill 集合（模型也忘了这个指令）。
   */
  resetReadState(): void {
    const count = this.readFiles.size;
    const skillCount = this.pendingSkillPaths.size;
    this.readFiles.clear();
    this.rejectionCounts.clear();
    this.pendingSkillPaths.clear();
    this.onDebug?.(`Prerequisite: reset read state (cleared ${count} reads, ${skillCount} skill prerequisites)`);
  }

  /**
   * 查询某个文件是否已被读过（主要供测试用）。
   */
  hasRead(filePath: string): boolean {
    return this.readFiles.has(expandPath(filePath));
  }
}
