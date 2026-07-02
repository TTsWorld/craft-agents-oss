/**
 * Render Template Handler（模板渲染处理器）
 *
 * 用 Mustache 语法把数据和 HTML 模板渲染成最终页面。
 * 模板按 source 存放在 workspace/sources/{source}/templates/ 下。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { loadTemplate, validateTemplateData } from '../templates/loader.ts';
import { renderMustache } from '../templates/mustache.ts';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// render_template 参数：source 名、模板名、渲染数据
export interface RenderTemplateArgs {
  source: string;
  template: string;
  data: Record<string, unknown>;
}

/**
 * 处理 render_template tool 调用。
 *
 * 流程：
 * 1. 校验 source 和模板文件存在；
 * 2. 软校验 data 是否满足模板里 @required 字段；
 * 3. 用 Mustache 渲染；
 * 4. 把结果 HTML 写入会话数据目录；
 * 5. 返回绝对路径，供 html-preview 块使用。
 */
export async function handleRenderTemplate(
  ctx: SessionToolContext,
  args: RenderTemplateArgs
): Promise<ToolResult> {
  if (!ctx.dataPath) {
    return errorResponse('render_template requires dataPath in context.');
  }

  const sourcePath = join(ctx.workspacePath, 'sources', args.source);

  // 校验 source 目录存在
  if (!existsSync(sourcePath)) {
    return errorResponse(
      `Source "${args.source}" not found at ${sourcePath}`
    );
  }

  // 加载模板
  const template = loadTemplate(sourcePath, args.template);
  if (!template) {
    return errorResponse(
      `Template "${args.template}" not found for source "${args.source}".\n\nExpected file: ${join(sourcePath, 'templates', `${args.template}.html`)}`
    );
  }

  // 软校验：缺少必填字段时只作为 warning，不阻止渲染
  const warnings = validateTemplateData(template.meta, args.data);

  // 渲染模板
  let rendered: string;
  try {
    rendered = renderMustache(template.content, args.data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Error rendering template "${args.template}": ${msg}`);
  }

  // 把输出写入会话数据目录
  const dataDir = ctx.dataPath;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const outputFileName = `${args.source}-${args.template}-${Date.now()}.html`;
  const outputPath = join(dataDir, outputFileName);
  writeFileSync(outputPath, rendered, 'utf-8');

  // 构造返回文本
  const lines: string[] = [];
  lines.push(`Rendered template: ${template.meta.name || args.template}`);
  lines.push(`Output: ${outputPath}`);
  lines.push('');
  lines.push(`Use this absolute path as the "src" value in your html-preview block.`);

  if (warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of warnings) {
      lines.push(`  - ${w.message}`);
    }
    lines.push('The template was rendered but may have blank sections. Consider re-rendering with the missing fields.');
  }

  return successResponse(lines.join('\n'));
}
