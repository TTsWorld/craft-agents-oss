from pathlib import Path

FILE = Path('apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx')

# Replacements for content inside multi-line JSX comments.
# Keys are the exact line content (after stripping leading whitespace/star).
JSX_CONTENT_REPLACEMENTS = {
    "the option from the # menu with no matches.": "用户从 # 菜单中选择“无匹配”项时。",
    "Spread the full config so optional fields like `inlineExecution`,": "展开完整配置，让 `inlineExecution` 等可选字段",
    "`displayLabel`, and `displayLabelKey` reach the popover. The previous": "以及 `displayLabel`、`displayLabelKey` 都能传入弹出框。",
    "cherry-pick dropped `inlineExecution: true`, which made the popover": "之前的手动挑选漏掉了 `inlineExecution: true`，导致弹出框",
    "fall back to the same-window deep-link path; that worked inside": "回退到同窗口深链路径；这在 Electron 内可用，",
    "Electron but launched the desktop app from the WebUI via `craftagents://`.": "但在 WebUI 里会通过 `craftagents://` 拉起桌面应用。",
    "Match the AppShell pattern (which already uses spread).": "与 AppShell 中已使用的展开模式保持一致。",
    "where the renderer can both detect text-only models and offer to": "渲染层既能检测到纯文本模型，也能提供",
    "flip the per-model supportsImages override on the spot.": "就地切换该模型 supportsImages 覆盖的入口。",
    "Wrapper absorbs all squeeze so the model label truncates first and the send button stays": "包装层吸收所有挤压，让模型标签先截断，发送按钮始终",
    "anchored to the right (craft-agents-oss#798). overflow-hidden is safe — Radix Drawer /": "锚定在右侧（craft-agents-oss#798）。overflow-hidden 安全——Radix Drawer/",
    "dropdowns inside render via portals, so they aren't clipped.": "内部的下拉通过 portal 渲染，不会被裁剪。",
    "collapsed during processing in compact mode, so the user can": "让用户无需等待 agent 处理结束即可",
    "type a follow-up without waiting for the agent to finish.": "输入跟进消息。",
}


def main():
    text = FILE.read_text(encoding='utf-8')
    lines = text.splitlines(keepends=True)
    out_lines = []
    in_jsx_comment = False

    for raw_line in lines:
        line = raw_line.rstrip('\n')
        if '{/*' in line:
            in_jsx_comment = True

        if in_jsx_comment:
            # Strip leading whitespace and possible leading '*' for multi-line JSX comment continuation
            stripped = line.lstrip()
            content = stripped.lstrip('*').strip()
            if content in JSX_CONTENT_REPLACEMENTS:
                new_content = JSX_CONTENT_REPLACEMENTS[content]
                if new_content == "":
                    out_lines.append('\n')
                else:
                    # Preserve original indentation
                    indent = line[:len(line) - len(stripped)]
                    # Re-add leading '*' and spacing if original line had it
                    if stripped.startswith('*'):
                        line = f"{indent}* {new_content}"
                    else:
                        line = f"{indent}{new_content}"

        out_lines.append(line + '\n')

        if '*/}' in line:
            in_jsx_comment = False

    FILE.write_text(''.join(out_lines), encoding='utf-8')
    print(f"Updated {FILE}")


if __name__ == '__main__':
    main()
