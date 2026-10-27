---
name: pr
description: |
  提交 PR 时写人话：这改了什么 / 怎么验的 / 会影响谁。判据就这三段，没别的。
  gate 生成 body 时照它填（`tools/gate/prbody.js`），人不手写；不满意就手改 `.git/gate-pr-body.md`。
  什么时候用：任何要落到 PR 的改动收尾时。中文触发：写 PR、填 PR 描述、PR 不像人、提 PR。
metadata:
  author: "mattpocock-skills（改写）"
  version: "2.0.0"
---

# /pr — 三段，说人话

看 PR 的人只有两分钟。他要的是：**改了什么、验过没有、合错了会怎样。**
三段说完，diff 自己会说话。

本仓库不手写 body：`node tools/gate.js pr` 按这个形状生成，你只读一遍、觉得哪句不像人话就改。

## 模板

```markdown
## 这改了什么

<一句话：现在能做到什么 / 修掉了什么。不是"实现了 XX 模块">

```text
src/
├── proactive/index.js  改动
└── ...
```

## 怎么验的

- 本地：check 无输出 · test 112/112 全过 · smoke 0；CI 双平台还没跑
- 用例：`test/s2/t09-proactive.test.js`（改动）

## 会影响谁

后端行为、自动化用例。回滚就是一次 `git revert`。
```

票通道在后面还有验收项 / 票号 / 同意项 / 遗留（`Workflow.md` §9 要的，一条不少）；
bug 通道多一段「怎么改的」（根因 + 修法）。文件超过 6 个，清单折进 `<details>`，正文只留形状。

## 四条规则

1. **一句话就够。** 第一段超过两行，说明没想清楚。"已完美实现""大幅提升"这类自我评价删掉。
2. **数字必须来自这一次。** gate 在生成 body 前会重跑门禁，勾选和 `112/112` 都是刚跑出来的，不是回忆。
3. **影响面要点出回滚代价。** 碰了数据迁移、契约、CI、依赖，就不是一次 `revert` 的事，得写出来。
4. **不编 Before。** bug 通道的"之前什么样"来自 commit body 的症状；没有就别说。

## 不好用的时候

生成完直接改文件，比加参数快：

```powershell
node tools/gate.js pr                                  # 生成并预览，body 在 .git/gate-pr-body.md
notepad .git/gate-pr-body.md                           # 哪句不像人话就改哪句
gh pr create --base main --title "…" --body-file .git/gate-pr-body.md
```

合并仍然是人的动作（`Rule.md §7-22`）。出处见同目录 `CREDITS.md`。
