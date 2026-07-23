# Harness Engineering 与 AI Coding 驱动情况

## 结论

按当前仓库文件判断：这个仓库没有成体系地用 harness engineering 驱动 AI coding。

它有一些零散的 AI/agent 友好材料：`AGENTS.md`、包内 `CLAUDE.md`、验证脚本、CI workflow。它们能帮助 agent 理解仓库和跑验证，但还不是完整 harness。完整 harness 至少应包含：明确的任务入口、项目级规则、可复用技能或流程、验证清单、完成证明、状态/交接机制，以及这些材料被 agent 或 CI 稳定消费的路径。

## 事实源

本文只使用当前仓库文件作为事实源，不使用 `docs/code-research/`、历史记忆或互联网资料。

## 当前已有的部分

### 1. `AGENTS.md`：有仓库贡献指南，但不是任务 harness

根目录 `AGENTS.md` 描述项目结构、命令、编码风格、测试规则、提交和 PR 要求（`AGENTS.md:3-33`）。这对 AI coding 有帮助，但它是通用 contributor guide，没有定义任务状态、完成证明、计划格式、handoff、风险记录或“做到什么才算完成”的强制流程。

结论：这是 AI 友好的仓库说明，不是完整 harness。

### 2. 包内 `CLAUDE.md`：有局部硬规则，但范围有限

`packages/core/CLAUDE.md` 说明 `@craft-agent/core` 的用途、命令和硬规则，例如保持类型层稳定、少依赖、改 exported types 时检查下游（`packages/core/CLAUDE.md:3-23`）。

`packages/shared/CLAUDE.md` 更强，包含 shared 包的 hard rules、维护 notes、i18n 规则和 backend contract（`packages/shared/CLAUDE.md:22-48`, `packages/shared/CLAUDE.md:49-198`）。

结论：这些是局部上下文文件，可以约束 agent 在特定目录的行为；但它们没有覆盖整个仓库的 AI coding 生命周期。

### 3. 验证命令：有 CI/本地验证，但不是 agent 工作流

根 `package.json` 提供 `bun test`、`typecheck:all`、`validate:dev`、`validate:ci`、lint 等命令（`package.json:23-55`）。`.github/workflows/validate.yml` 在 push/PR 上运行 `bun run validate:ci`（`.github/workflows/validate.yml:1-45`）。

结论：验证入口存在，这是 harness 的必要部件；但它只回答“代码是否过检查”，不驱动 agent 如何计划、执行、证明和交接。

### 4. `.github/agents`：workflow 引用存在，但目录不存在

`.github/workflows/validate-server.yml` 运行 `--validate-server --workspace-dir .github/agents`（`.github/workflows/validate-server.yml:30-34`）。但当前仓库中 `.github/agents` 目录不存在。

结论：这不是一个可用的仓库级 agent workspace/harness。当前只能说明 workflow 期待一个 workspace 目录，不能说明仓库已经用它驱动 AI coding。

### 5. `.harness`：是我们新放的文档入口，不是既有机制

`.harness/README.md` 和 `.harness/completion-proof.template.md` 是项目级文档和模板。当前源码没有消费 `.harness`，也没有 runtime gate 使用 completion proof。

结论：`.harness` 现在只是文档约定，不是已运行的 AI coding harness。

## 没有看到的关键部件

当前仓库没有看到这些能证明“用 harness engineering 驱动 AI coding”的项目级材料：

- 根目录没有 `.agents/skills/` 项目技能。
- 没有可执行的项目级 AI coding playbook。
- 没有任务计划、状态、完成证明的固定存放路径和消费机制。
- 没有把 completion proof 和 `set_session_status("done")` 或 CI gate 连接起来。
- 没有仓库级 `automations.json` 来驱动开发任务流。
- 没有可用的 `.github/agents` 工作区，尽管 workflow 引用了它。

## 容易混淆的一点

这个项目本身是一个 agent 产品，所以源码里有很多 harness-like runtime：context files、skills、sources、automations、session tools、permission modes、status events 等。

但这些主要是在实现 Craft Agents 这个产品，而不是说明当前仓库已经用 harness engineering 来驱动自己的 AI coding。换句话说：

- “产品支持 harness-like 能力”是成立的。
- “这个仓库自身已经用 harness engineering 驱动开发”证据不足。

## 判定

当前状态更准确地说是：弱 harness / 半成品 harness。

已有部分：

- `AGENTS.md` 提供通用仓库说明。
- `CLAUDE.md` 提供包级维护规则。
- `package.json` 和 GitHub Actions 提供验证入口。
- `.harness` 现在提供分析和完成证明模板。

缺失部分：

- 没有项目级技能和 playbook。
- 没有任务状态与 proof 的强制闭环。
- 没有可用的 `.github/agents` 工作区。
- 没有把 AI coding 流程接到 CI 或 repo automation。

所以答案是：没有真正用 harness engineering 驱动 AI coding；目前只是具备若干可以组成 harness 的零件。
