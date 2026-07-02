/**
 * Skill Validate Handler（Skill 校验处理器）
 *
 * 校验某个 skill 的 SKILL.md 文件格式与必填字段。
 * skill 按三级优先级查找：project > workspace > global。
 *
 * workingDirectory 会按需从持久化的 session.jsonl 头部解析，
 * 不需要在构造时传递；如果解析失败，则跳过 project 级 skill 并给出 warning。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { resolveSessionWorkingDirectory } from '../source-helpers.ts';
import {
  validateSlug,
  validateSkillContent,
  formatValidationResult,
} from '../validation.ts';

// skill_validate 参数：skill 的 slug（短标识）
export interface SkillValidateArgs {
  skillSlug: string;
}

/**
 * 按三级优先级解析 SKILL.md 路径：project > workspace > global。
 * 返回第一个匹配的路径与级别；找不到则返回 null。
 */
function resolveSkillMdPath(
  ctx: SessionToolContext,
  slug: string,
  workingDirectory: string | undefined
): { path: string; tier: string } | null {
  // 1. Project 级（最高优先级）：{projectRoot}/.agents/skills/{slug}/SKILL.md
  if (workingDirectory) {
    const projectPath = join(workingDirectory, '.agents', 'skills', slug, 'SKILL.md');
    if (ctx.fs.exists(projectPath)) {
      return { path: projectPath, tier: 'project' };
    }
  }

  // 2. Workspace 级（中等优先级）：{workspace}/skills/{slug}/SKILL.md
  const workspacePath = join(ctx.workspacePath, 'skills', slug, 'SKILL.md');
  if (ctx.fs.exists(workspacePath)) {
    return { path: workspacePath, tier: 'workspace' };
  }

  // 3. Global 级（最低优先级）：~/.agents/skills/{slug}/SKILL.md
  const globalPath = join(homedir(), '.agents', 'skills', slug, 'SKILL.md');
  if (ctx.fs.exists(globalPath)) {
    return { path: globalPath, tier: 'global' };
  }

  return null;
}

/**
 * 处理 skill_validate tool 调用。
 *
 * 流程：
 * 1. 校验 slug 格式；
 * 2. 从上下文或 session 头部解析 workingDirectory；
 * 3. 按 project > workspace > global 三级查找 SKILL.md；
 * 4. 读取并校验内容（frontmatter + body）；
 * 5. 返回校验结果，若跳过 project 级则附带 warning。
 */
export async function handleSkillValidate(
  ctx: SessionToolContext,
  args: SkillValidateArgs
): Promise<ToolResult> {
  const { skillSlug } = args;

  // 先校验 slug 格式
  const slugResult = validateSlug(skillSlug);
  if (!slugResult.valid) {
    return {
      content: [{ type: 'text', text: formatValidationResult(slugResult) }],
      isError: true,
    };
  }

  // 解析 workingDirectory：优先用上下文，否则从 session 头部解析
  const workingDirectory = ctx.workingDirectory
    ?? resolveSessionWorkingDirectory(ctx.workspacePath, ctx.sessionId);

  // 三级查找 SKILL.md
  const resolved = resolveSkillMdPath(ctx, skillSlug, workingDirectory);
  if (!resolved) {
    const searchedPaths = [
      workingDirectory ? `  - ${join(workingDirectory, '.agents', 'skills', skillSlug, 'SKILL.md')} (project)` : null,
      `  - ${join(ctx.workspacePath, 'skills', skillSlug, 'SKILL.md')} (workspace)`,
      `  - ${join(homedir(), '.agents', 'skills', skillSlug, 'SKILL.md')} (global)`,
    ].filter(Boolean).join('\n');

    const warning = !workingDirectory
      ? '\n\nNote: Project-level skills (.agents/skills/) were not checked — working directory could not be resolved.'
      : '';

    return errorResponse(
      `SKILL.md not found for skill "${skillSlug}". Searched:\n${searchedPaths}${warning}\n\nCreate it with YAML frontmatter.`
    );
  }

  // 读取并校验 SKILL.md 内容
  let content: string;
  try {
    content = ctx.fs.readFile(resolved.path);
  } catch (e) {
    return errorResponse(
      `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  const result = validateSkillContent(content, skillSlug);
  const tierInfo = `Validated from ${resolved.tier} tier: ${resolved.path}`;
  const formatted = formatValidationResult(result);

  // 如果 workingDirectory 解析失败，提示 project 级被跳过
  const warnings: string[] = [];
  if (!workingDirectory) {
    warnings.push('Note: Project-level skills (.agents/skills/) were not checked — working directory could not be resolved.');
  }
  const warningText = warnings.length > 0 ? '\n\n' + warnings.join('\n') : '';

  return {
    content: [{ type: 'text', text: `${tierInfo}\n\n${formatted}${warningText}` }],
    isError: !result.valid, // 只有校验不通过才算 error，warning 不算
  };
}
