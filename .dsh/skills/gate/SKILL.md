---
name: gate
description: |
  把「改完代码 → 自动检查 → 合规扫描 → 格式化提交 → 开 PR」压成五段流水线，一条命令跑完。
  用法在 `tools/gate.js`，判据在本文件；它不替你写代码，也不替你合并。
  什么时候用：任何一批要落到 PR 的改动收尾时。中文触发：跑一下 gate、过闸、跑门禁、过一下检查、帮我提交、提 PR、把这批改动过一遍。
metadata:
  author: "ai-qq"
  version: "1.0.0"
---

# /gate — 改完之后那五段

`Workflow.md` 把一票的流程写成 0–9 步，其中 5–9（门禁、关票、PR、合并、汇报）每次都要人肉重复。
这条流水线只自动化中间那一段，边界很清楚：

| 你的说法 | 这里叫什么 | 谁做 |
|---|---|---|
| 完成代码修改 | — | **你**。gate 不写代码，也不猜需求 |
| 自动检查 | `check` | `npm run check` → `npm test` → `npm run smoke`，与 CI 同一道门 |
| 合规扫描 | `compliance` | G01–G28：Rule.md 里人肉才看得出的条款 |
| 格式化提交 | `format` + `commit` | 安全收敛 + 规范 message + 显式 `git add` |
| 创建 PR | `pr` | 七段 / 五段 body 自动生成；`--push --create` 才真的动网 |

**门禁只有一道。** `check` 阶段跑的就是 `package.json` 里那三条命令，不是另写一套"轻量检查"。
本地绿不等于 CI 绿（平台差异），但本地红一定不能提 PR。

## 铁律（违反就不是这条流水线了）

1. **红就是红。** 不许 `--skip`、不许放宽阈值、不许注释断言、不许改 CI 让它变绿（`Rule.md §7-19`、§7-21）。
2. **合并是人的动作。** `tools/gate.js` 里没有 `gh pr merge`。你也不许敲（`Rule.md §7-22`）。
3. **同意项不能靠 flag 蒙过去。** `--consent=A8` 只是让你继续，PR 里仍要贴人的答复原文（`Rule.md §8`）。
4. **不替人编内容。** bug 通道缺"症状/根因/修法/验证"四段，`commit` 直接拒绝，不生成占位文案。

## 五段怎么跑

### ① 改代码（不是 gate 的活）

按 `Workflow.md` §5：先红后绿，用例落 `test/s1|s2|s3`，名字写用户看到什么。
改完先跑一次最快的：

```powershell
node tools/gate.js compliance        # 秒级，只查 Rule.md 那几条
```

合规扫描适合边改边跑。它不跑测试，只回答"我是不是踩了红线"。

### ② 自动检查

```powershell
node tools/gate.js check             # 三段门禁，主动 20–25 秒
node tools/gate.js check --fast      # 只要静态自检，1 秒
```

顺序固定：`check` 红就不跑 `test`，`test` 红就不跑 `smoke`（`Workflow.md` §6）。
失败时它会打印末尾 25 行，别去猜。

### ③ 合规扫描

```powershell
node tools/gate.js compliance --paths=src,test
```

| ID | 拦什么 | 依据 |
|---|---|---|
| G01 | `data/`、`*.db`、`.env`、`.tmp-*`、`.repro*`、`NUL` 进仓库 | Rule §7-18 |
| G02 | 改 `prototype/`、PRD、`docs/ai-companion-spec.md`、`docs/agents/` | Rule §8-A7 |
| G03 | 改 `.github/workflows/` | Rule §7-21、§8-A8 |
| G04 | 单文件 > 512KB | 别把产物塞进来 |
| G05 | 冒出 lockfile | ADR-0002 零依赖 |
| G10 | `sk-` / `ghp_` / `AKIA` / 私钥块 / 硬编码 `api_key` | Rule §6-S2 |
| G11 | `test.skip` / `test.only` | Rule §7-19 |
| G12 | 空 `catch {}` | Rule §3.2 |
| G13 | 角色文案里出现"作为一个 AI""token 余额" | Rule §7-2 |
| G20/G21 | 在 `main` 上直接改；分支名不合 `ticket-NN-*` / `fix-*` | Rule §7-22 |
| G22–G25 | 票文件找不到、`Status` 不是 `done`、验收项没勾、缺 `## Notes` | Workflow §8 |
| G26 | 改了 `src/` 没改 `test/` | Workflow §5（`--hotfix` 降级） |
| G27 | commit 标题不合 `type(scope): 描述` | Workflow §9 |
| G28 | 一票改动散在 6 个以上 `src` 模块 | Workflow §12.3 |

WARN 不拦提交，但它是在说"这里有人要看一眼"。别整片无视。

哪里硬拦，哪里只是提醒，按三条标准分：

| 组 | 规则 | 级别 | 为什么 |
|---|---|---|---|
| 洗不掉的 | G01、G10 | 拦 | 进了 git 历史要 rewrite 才清得掉 |
| 让"绿"变假的 | G03、G05、G11 | 拦 | 用工具把测试弄绿，Rule §7-19 与 §7-21 是同一件事 |
| 产品红线 | G13 | 拦 | Rule §7-2 |
| 流程写死的 | G02、G04、G12、G20、G22–G25、G27 | 拦 | G12 没有正当写法，想忽略就显式 `return` |
| 可能是正当的 | G06、G14、G21、G26、G28、G29 | 提醒 | G26 拦了只会逼人写空壳用例，比不写更坏 |

格式化差异不拦：`web/app.js` 五万八千字节、`styles.css` 三万四千字节，历史行尾本来就不统一。硬拦等于要求每次碰这些文件都全文件重排，diff 会变成"改两行、红一千行"。只收敛你自己改过的文件。

### ④ 格式化提交

```powershell
node tools/gate.js format            # 只看，不写
node tools/gate.js --fix             # 写回 + git add（只动已跟踪文件）
```

格式化只做**改回去也不影响语义**的那几件事：去 BOM、统一行尾（跟 `.gitattributes`）、去行尾空白、末尾补一个换行、连续空行压到两行。
**不做**缩进、引号、分号、import 排序。这个仓库零依赖（ADR-0002），没有 prettier，也不该为了格式化装一个。

Markdown 的行尾两个空格是硬换行，不动；未跟踪的新文件不动（先 `git add`）。

提交：

```powershell
node tools/gate.js commit                                    # dry-run，先看 message
node tools/gate.js commit --no-dry-run                       # 真的提交
node tools/gate.js commit --subject="..." --no-dry-run       # 自己定标题
node tools/gate.js commit --amend --no-dry-run               # 推之前收尾，改写上一个提交
```

`commit` 的顺序是格式化 → 门禁 → 合规 → 写 message → `git add` → commit。
格式化作在提交里面，所以不用记得先敲 `--fix`。`check` 与 `compliance` 都在里面重跑一遍，带着红提交不了。
标题从票标题或分支 slug 推，正文带票路径 + 改动面 + 门禁结果。

`--amend` 默认沿用原 message：收尾不该顺手改标题。要改就同时给 `--subject`。

**想让手敲的 `git commit` 也过闸**，装一次 hook：

```powershell
node tools/gate.js install-hook
```

它写的是 `.git/hooks/pre-commit`，七行 sh，跑 `check --fast` 和 `compliance` 两条。`.git/hooks` 不进版本库，所以每台机器各自装一次，不替你装。全量测试留给 `gate commit` 和 CI，不让每次提交都等二十秒。想跳过就 `git commit --no-verify`。

bug 通道（`/fix-bug`）必须自己给四段：

```powershell
# 先写文件，避免 PowerShell 里转义换行
@'
症状：3000 被占时进程起在 3001，控制台却仍打印 3000
根因：启动日志读的是配置值，不是 http.start() 返回的实际端口
修法：改用返回值拼地址，一处
验证：test/s1/t17-startup-url.test.js（端口 0）
'@ | Set-Content .git/gate-commit-body.md -Encoding utf8

node tools/gate.js commit --body-file=.git/gate-commit-body.md --no-dry-run
```

### ⑤ 创建 PR

```powershell
node tools/gate.js pr                       # 生成并预览 body，不推不建
node tools/gate.js pr --push                # 推分支
node tools/gate.js pr --push --create       # 推 + 开 PR
```

body 写到 `.git/gate-pr-body.md`（不入库）：

- 票分支 → 七段（这张票 / 改动面 / 验收项 / 门禁 / 偏差与风险 / 同意项 / 遗留），验收项和 Notes 里的偏差、遗留直接从票里抓。
- `fix-` 分支 → 五段（症状 / 根因 / 改动 / 验证 / 风险与回归面），内容来自 commit body。
- `chore/` `docs/` → 照实列改动文件与 commit 标题，不硬套前两套。

它会在生成 body 前**再跑一遍门禁**：PR 里的勾选必须是刚跑出来的，不是回忆出来的。
开 PR 之前它还会拦三件事：工作区不干净、commit 标题不合规范、票没关（`Status: done` + 验收项全勾 + 有 `## Notes`）。

**最后一步永远是人的**：看 diff、看 CI 双平台、点 squash merge。合并完你再 `git switch main && git pull --ff-only`。

## 红了怎么办

先分类，再动手（`Workflow.md` §7 是同一张表，这里只补 gate 自己的输出）：

| 现象 | 先判断 | 动作 |
|---|---|---|
| `G01` 命中 `data/` 或 `*.db` | 是不是 `git add -A` 带进来的 | `git restore --staged <path>`，别改规则 |
| `G02`/`G03` 命中 | 真的必须改上游/CI 吗 | 停下来问人；得到答复再加 `--consent=A7`/`A8` |
| `G10` 命中 | 真密钥还是文档示例 | 真密钥：删干净 + 换 key；示例：挪进 `.md` 或改成占位符 |
| `G11` 命中 | 是不是调试时忘了删 | 删掉 `skip/only`，别用 `--test-name-pattern` 挑着跑当全绿 |
| `G13` 命中 | 文案归属模块对不对 | 系统信息只进界面角标，不进角色文案 |
| `G22`–`G25` 命中 | 票还没关完 | 回去勾验收项、改 `Status`、补 `## Notes` |
| `G27` 命中 | commit 已经在分支上了 | `git commit --amend` 改标题；已推就 `git push --force-with-lease` 到自己的分支 |
| `check` 阶段 `npm test` 红 | 实现错还是用例错 | 按 `Workflow.md` §7 分类；**红线用例红 → 停下汇报** |
| `smoke` 红 | 端口/启动超时 | 先看是不是上一条用例没杀干净 |
| `format` 报了一堆 | 历史文件本来就不是 LF | 别一次性 `--fix` 全仓库，只 `--fix --paths=<你改的目录>` |

30 分钟还没缩小范围 → 停下来汇报：现象、已排除的假设、需要人回答的**一个**问题。

## 什么时候必须停下问人

- 命中 `Rule.md §8` 任何一条（A1–A13），尤其是 CI 门禁、契约、数据模型、依赖。
- 票的验收项勾不动、`Blocked by` 没解除、或者发现 spec 自相矛盾（`Workflow.md` §12.2）。
- 一条改动要跨 6 个以上模块（`G28`）——那多半不是一张票。
- 想加依赖来"让格式化/检查更省事"。零依赖是基础设施决策，不是偏好。

## 不产生的东西

- 不新增 `.scratch/**/issues/` 文件（票是 `to-tickets` 的活）。
- 不写「修复记录.md」「门禁说明.md」这类旁路文档。记录只在这三处：commit message、PR body、`tools/gate/rules.js` 的规则 ID。
- 不改 `package.json` 的既有 script 名。也不加 `npm run gate` 这种短入口：`node tools/gate.js` 已经够短，为一个别名走一次 `Rule.md §8-A12` 不划算。

## 自检

```powershell
node tools/gate.js selftest     # 15 条：规则命中/不命中、格式化边界、票解析、PR 版式
```

改了 `tools/gate/rules.js` 的规则，先给 `selftest.js` 加一条用例，再改规则。
`test/` 是产品三个缝（S1/S2/S3），工具自检不进那里。
