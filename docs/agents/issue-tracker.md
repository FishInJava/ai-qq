# Issue tracker

**Where issues live:** local markdown files inside this repo, under `.scratch/`.

本仓库是 git 仓库，远端是 GitHub（`FishInJava/ai-qq`），**但 tracker 仍在本地**：`to-spec`、`to-tickets`、`implement-spec` 一律读写本地 markdown，不要改去连 GitHub Issues / Linear。理由只有一条：票是写给**下一个 agent 会话**的上下文包，要能被 `read`/`grep` 直接读、能跟分支一起走、能在离线时用；GitHub Issues 要走 `gh api`，多一层 token 与网络依赖。

**bug 不进 tracker。** 期望行为已经在 spec / PRD / 原型 / 用例里写定、只是实现没跟上的，走 `/fix-bug`（`.dsh/skills/fix-bug/SKILL.md`）：不建票文件、不勾验收项、不写 `## Notes`，记录落在 commit message 与 PR body。判定门槛见 `Workflow.md` §0。

## Layout

```
.scratch/
  <feature-slug>/
    spec.md          # 由 to-spec 写出，单文件，整篇 spec
    issues/
      01-<slug>.md   # 由 to-tickets 写出，一个 ticket 一个文件，按依赖顺序编号
      02-<slug>.md
    notes/           # 探索子代理写下的调研笔记（可选）
```

- `<feature-slug>`：2-4 个词，kebab-case，例如 `ai-companion-memory`。
- `spec.md` 顶部写 `# <feature 名称>`，正文严格用 `to-spec` 的模板分节。
- ticket 文件编号从 `01` 开始，**blocker 在前**；编号顺序即依赖拓扑顺序。

## Ticket file format

```markdown
# <NN>: <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None (can start immediately)".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

## Status vocabulary

| Status | 含义 |
| --- | --- |
| `needs-triage` | 刚进队列，还没人看 |
| `needs-info` | 缺信息，等提问回答 |
| `ready-for-agent` | 可直接交给代理实现（`to-spec` / `to-tickets` 的默认输出） |
| `ready-for-human` | 需要人拍板或人手动做 |
| `wontfix` | 明确不做 |
| `done` | 已实现并验收 |

## Closing work

本地 tracker 用"改文件"关票，没有自动状态流：

1. 验收项全部勾选 `- [x]`；
2. `**Status:**` 改为 `done`；
3. 在票末追加 `## Notes` 段落，写清实际落地了什么、和 spec 的偏差、遗留项。

这三步只适用于**票**。走 `/fix-bug` 的 bug 没有票可关，也不许为了让流程"看起来完整"补一张。

## PRs as a request surface

on（GitHub，`FishInJava/ai-qq`）。PR 是给人看的审阅面，票是给 agent 看的上下文包——同一件事的两份记录，各管一头：
- 票 → 七段模板（`.github/pull_request_template.md`），带验收项勾选；
- bug → 五段短版（`.dsh/skills/fix-bug/SKILL.md` §5），没有票就不填验收项。
