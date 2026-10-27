# Credits

本目录的 `pr` skill 是 [mattpocock/skills](https://github.com/mattpocock/skills) 里
`skills/engineering/pr/SKILL.md` 的改写版（MIT，Copyright (c) 2026 Matt Pocock）。

改写的地方：

- 中文重写，并把"照着写 body"换成"按这个形状生成 body"——本仓库的 body 由 `tools/gate.js pr` 产出，
  判据留在本文件，填充在 `tools/gate/prbody.js`。
- 砍到三段（这改了什么 / 怎么验的 / 会影响谁），后面接上本仓库既有的验收项、同意项、遗留，
  因为 `Workflow.md` §9 与 `.github/pull_request_template.md` 还要求这些，事实一条不少，只是标题换成人话。
- 原 skill 的 Before/After 证据与 one-way/two-way 的门，收成一句话（影响面 + 回滚代价），
  不给它单独开段和参数——写 PR 的人不该为了填表去记 flag。

原 skill 的 Summary 视觉菜单（伪代码、调用树、组件树、目录树、Mermaid、diff 及摆放建议）来自
[Dex Horthy](https://github.com/dexhorthy) 的 [`show-me`](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md)
（Humanlayer），原 `pr` skill 已在其 `CREDITS.md` 里注明这份出处；这里继续沿用同一条归属。
`pr` 不依赖 `show-me` 作为 skill（它不在本仓库，硬依赖会破坏单装），所以内容是转述而不是引用。
