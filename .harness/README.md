# Craft Agents Harness 工程

## 事实源

本目录保存当前仓库的项目级 harness engineering 资料索引和证据模板。当前主分析文件已放到 `docs/harness-engineering-analysis.md`；其中所有结论只以当前源码和配置为事实源，不依赖 `docs/code-research/`、历史记忆或互联网资料。

## 当前边界

源码已经有运行时 harness：`AgentBackend`、`BaseAgent`、`PromptBuilder`、`PreToolUse`、`ModeManager`、source/skill 管理、session tools、`SessionManager`、automations 和 JSONL 持久化。

`.harness` 当前不是运行时入口。源码搜索没有发现 `packages/` 或 `apps/` 下引用 `.harness` 字面量；因此这里先作为项目级约束、分析和完成证据目录，而不是新框架或配置系统。

## 文件

- `../docs/harness-engineering-analysis.md`：源码依据版 harness engineering 分析和设计边界。
- `completion-proof.template.md`：非平凡任务结束时可填写的完成证据模板。
- `README.md`：本目录的索引和使用约束。

暂不创建空的 `profiles/`、`checks/`、`playbooks/`。等源码或日常流程真的消费这些文件时再加。

## 工作规则

对这个仓库做 harness 相关工作时：

1. 先读真实源码、配置和测试。
2. 不把 `.harness` 伪装成已经被 runtime 消费的机制。
3. 不重复实现已有权限、source、skill、session tool 或 persistence 机制。
4. 如果需要把完成证明接入 runtime，只能从现有 session tools 和 `SessionManager.setSessionStatus` 这些源码入口开始。
5. 每个非平凡改动都要留下验证命令、结果和未验证项。

## 验证命令

这些命令来自根目录 `package.json` scripts：

- `bun test`：运行默认测试和 `*.isolated.ts` 测试。
- `bun run typecheck:all`：对 core/shared/server/session-tools/electron/ui 等包做全量类型检查。
- `bun run test:shared:all`：跑 shared 关键配置与模型测试。
- `bun run test:doc-tools`：跑文档工具 smoke tests。
- `bun run validate:dev`：串联全量 typecheck、shared tests 和 doc tools tests。

如果当前工作树已有冲突或无关失败，在 completion proof 中记录，不要把跳过项写成通过。
