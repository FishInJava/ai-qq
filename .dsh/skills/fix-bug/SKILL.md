---
name: fix-bug
description: |
  内建 bug / 小修的快速通道：不写票，直接分支 → 红测 → 修 → 门禁 → 一个 commit → 一个短 PR。
  只在「把实现改回 spec / PRD / 原型已经写定的行为」时用它；引入新行为请走票（to-spec / to-tickets）。
  Use when fixing a bug or a small regression: no ticket file, one commit, one short PR.
  中文触发：修个 bug、这个 bug 修一下、修一下这个报错、/fix-bug、小改动、回归修复、别写票了直接修。
metadata:
  author: "ai-qq"
  version: "1.0.0"
---

# /fix-bug — 修 bug 不写票

这个仓库的票制度本来是为「新行为要先对齐需求」设计的。bug 修复不需要对齐需求：一致的东西早就写在 spec / PRD / 原型 / 被测用例里了，缺的只是让实现跟上。所以 bug 走这条轻通道，**一张票文件都不产生**。

配套规则见 `Workflow.md` §0.1（判定门槛）、§9.1（短 PR 格式）、`docs/agents/issue-tracker.md`（bug 不入 tracker）。

## 0. 先判定：这真的是 bug 吗

依次回答，任意一条答「否」就停下，改用票（`to-tickets` 或手写一张 `.scratch/<feature>/issues/NN-*.md`）：

| 检查 | 是才继续 |
|---|---|
| 期望行为在 spec / PRD / 原型 / 现有用例里**已经写定**？ | ← 这条最关键。写不出来的"期望"= 新功能，不是 bug |
| 只把实现改回约定，不引入任何新行为、新字段、新接口？ | |
| 不碰 `docs/ARCHITECTURE.md §6` 对外契约？ | 碰了 → `needs-decision`，问人（Rule §8-A2） |
| 不碰数据模型/迁移、不加依赖、不改 `Rule.md §8` 任何同意项？ | 碰了 → 停下问人 |
| 不搬红线的归属模块（`ARCHITECTURE §8`）？ | 要搬 → 那是架构改动，不是修 bug |
| 改动集中在一个模块（最多两个相邻模块）？ | 散在三个以上 → 多半是设计问题，转票 |

判定结果写进 commit message 的第一行下面的 body，一句话就行：`与 spec §X / 用例 Y 不一致`。

## 1. 分支

```powershell
git switch main
git pull --ff-only origin main
git switch -c fix-<slug>          # 例：fix-startup-url-port
```

`fix-<slug>`，不带票号。分支名里不许出现 `ticket-`，出现了就说明该走票。

## 2. 先红后绿（能测就必须测）

1. **复现**：按 `Workflow.md` §7 的分类找落点，写一条失败用例。
   - 对外行为 → `test/s1/`，用例名写用户视角的现象，不写函数名。
   - LLM 剧本 → `test/s2/`，剧本放 `test/fixtures/fake-llm/`。
   - 时间/调度/tick → `test/s3/`。
   - 跑一次，确认它**因为预期原因**红（不是语法错、不是端口占用）。
2. **测不出来**（纯文案、纯启动输出、只在人工点击时可见）：在 PR body 里写清手动复现与验证步骤，别硬造一条假用例。**不许**为了"有测试"写一条只断言常量等于自己的空壳用例。
3. **修**：最小改动。不许顺手重构别的模块、不许改断言放宽阈值（`Rule.md §7-19`）。根因在契约/数据/依赖上 → 回 §0 表格，转票或问人。
4. **绿**：新用例转绿，且原来绿的还绿。

## 3. 门禁（顺序固定，前一步红不跑后面）

```powershell
npm run check
node --test test/s1/<受影响>.test.js   # 最快反馈
npm test                                 # 全量，不许挑着跑
npm run smoke
```

判定同 `Workflow.md` §6：`check` 无输出、全量全绿、smoke 退出码 0、3 秒内起得来。

## 4. 一个 commit

一个 bug 一个 commit，不拆「先加用例再修」两步（那是票的节奏）。

```
fix(<模块>): <用户看到的现象，一句话>

症状：<什么情况下发生，看到什么>
根因：<哪个文件哪一处，为什么>
修法：<改了什么，为什么这样改最小>
验证：<用例文件 + 手动步骤>
```

例：

```
fix(runtime): 端口被占用递增后仍打印配置里的端口

症状：3000 被占时进程起在 3001，控制台却仍打印 3000
根因：启动日志读的是配置值，不是 http.start() 返回的实际端口
修法：改用返回值拼地址，一处
验证：test/s1/t17-startup-url.test.js（端口 0）
```

`docs:` 之类的「关票」提交**不存在**在这条通道里。

## 5. 一个短 PR

`--body-file` 用下面这个五段模板，**不套** `.github/pull_request_template.md` 的七段版本（那是给票用的）：

```markdown
## 症状
<用户看到什么，怎么复现，影响谁>

## 根因
<文件:行 + 一句话解释>

## 改动
<文件清单，每个一行>

## 验证
- 新增/修改用例：`test/...`
- `npm run check` 无输出 / `npm test` N/N / `npm run smoke` 退出码 0
- 手动：<点了什么，看到什么>

## 风险与回归面
<可能有副作用的地方；无则写「无，改动局限于 X」>

关联：无票（bug 修复通道，见 `.dsh/skills/fix-bug/SKILL.md`）
```

分支推上去后由人合并，代理不许 `gh pr merge`（`Rule.md §7-22`）。

## 6. 不产生的东西

明确不写，别好心补上：

- `.scratch/**/issues/` 下任何新文件
- 票的 `## Notes*`、验收项勾选、`Status:` 变更
- 单独的 `docs: ...` 提交
- 任何"修复记录.md"「问题说明.md」这类旁路文档

记录活在三个地方，够回放了：**commit message（为什么）、PR body（改了什么）、用例名（怎么验的）**。需要长期记住的坑（平台差异、第三方行为）写进 `Coding阶段总结.md` 一行，或代码里那段的原因注释，不另开文件。

## 7. 修到一半发现不是 bug

很常见，直接升级，别硬凑成 bug：

- 根因是设计缺陷 / 要改契约 → 停，写票（`to-tickets`），PR 关掉或转 `needs-decision`。
- 根因是 spec 自身矛盾 → 按 `Workflow.md` §12.2：不改 spec，票 Notes 里写清，问人。
- 修了 30 分钟没缩小范围 → 停，汇报现象 + 已排除的假设 + 需要人回答的一个问题（`Workflow.md` §7 最后一行）。

## 汇报格式

五段，短：改了什么 / 怎么验证 / 偏差风险 / 需要你决定 / 下一步。同 `Workflow.md` §11。
