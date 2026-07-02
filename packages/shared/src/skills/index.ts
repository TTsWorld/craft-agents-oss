/**
 * Skills 模块入口
 *
 * Skill（技能）是用于扩展 Agent 能力的专项指令，通常以 Markdown 文件形式存放在
 * workspace 的 skills 目录下。本模块统一导出 skill 相关的类型定义与存储操作。
 *
 * 类比 Go：这个文件就像一个 package 的对外 API 清单，通过 export 把内部子包暴露出去。
 */

// 从当前目录的 types.ts 重新导出所有类型，相当于 Go 中把子包的类型提升到当前包可见。
export * from './types.ts';

// 从 storage.ts 导出 skill 的持久化相关函数与常量，供外部直接调用。
export {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  getSkillIconPath,
  deleteSkill,
  skillExists,
  listSkillSlugs,
  skillNeedsIconDownload,
  downloadSkillIcon,
} from './storage.ts';
