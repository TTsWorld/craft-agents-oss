/**
 * Mermaid Validate Handler（Mermaid 图表语法校验处理器）
 *
 * 使用 beautiful-mermaid 的渲染器校验图表语法是否合法。
 * 不需要 DOM，在 Claude 和 Codex 两种环境下行为一致。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { renderMermaidSVG } from 'beautiful-mermaid';
import { normalizeMermaidSource } from '../validation.ts';

// mermaid_validate 参数：code 为图表源码，render 当前未实际使用
export interface MermaidValidateArgs {
  code: string;
  render?: boolean;
}

/**
 * 处理 mermaid_validate tool 调用。
 *
 * 通过 renderMermaidSVG 来校验图表：能渲染成功即视为语法合法。
 * 校验前会先 normalizeMermaidSource 去掉 YAML frontmatter（那是元数据，不是图表语法）。
 * 如果渲染抛异常，就把错误信息返回给模型。
 */
export async function handleMermaidValidate(
  _ctx: SessionToolContext,
  args: MermaidValidateArgs
): Promise<ToolResult> {
  const { code } = args;

  try {
    // renderMermaidSVG 在语法或布局错误时会抛异常。
    // 这里用渲染路径而不是 parseMermaid()，后者只支持流程图/状态图等少数类型。
    renderMermaidSVG(normalizeMermaidSource(code));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          valid: true,
          message: 'Diagram syntax is valid',
        }, null, 2),
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown parse error';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          valid: false,
          error: errorMessage,
          suggestion: 'Check the syntax against ~/.craft-agent/docs/mermaid.md',
        }, null, 2),
      }],
      isError: true,
    };
  }
}
