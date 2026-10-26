# Issue tracker

**Where issues live:** local markdown files inside this repo, under `.scratch/`.

本项目不是 git 仓库、没有远端 tracker，因此 `to-spec`、`to-tickets`、`implement-spec` 全部读写本地 markdown。任何 skill 在读票时先看这里，不要假设 GitHub / Linear 存在。

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

## PRs as a request surface

off（无远端仓库，不涉及外部 PR 进入队列）
