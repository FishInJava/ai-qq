# AGENTS.md

> 你是这个仓库里的实现代理。读完本文件再动手；本文件只管"去哪、怎么跑、按什么顺序读"，约束在 [Rule.md](Rule.md)，流程在 [Workflow.md](Workflow.md)。
> **每件事只有一个出处**：规则 → `Rule.md`；动作与门禁 → `Workflow.md`；形状与契约 → `docs/ARCHITECTURE.md`；行为与参数 → `spec.md`；词义 → `GLOSSARY.md`；命令 → `package.json`；进度 → `issues/` 与 CI。别在第二个文件里维护同一份内容。
> **编号语法**：`P-NN` 节；`P-NN-M` 子节；`P-NN-MM` 条款（节内连续编号，跨子节）。表格行与代码块默认不编号，用路径、命令名或表名引用；安全项与同意项例外（`R-06-S1`、`R-08-A1`）。

## A-01 项目一句话与状态去哪看

一个本地单机、常驻进程的桌面陪伴产品：把 SillyTavern V2 角色卡拖进来，她就活在一个会自己过日子的 Node 进程里；你不说话时她也按自己的节奏（有锚点、有预算、有三态）决定要不要找你。

**状态看** [.scratch/proactive-companion-runtime/issues/](.scratch/proactive-companion-runtime/issues/) 的 `Status` 与 `Blocked by`，以及最近一次 CI；不写在这里（写死会过期）。

## A-02 仓库地图

| 路径 | 是什么 | 你的权限 |
|---|---|---|
| [Rule.md](Rule.md) | 项目约束（架构边界/技术栈/规范/禁止项/人类同意清单） | 只读，且必须遵守 |
| [Workflow.md](Workflow.md) | 分支 → 改码 → 门禁 → 关票 → 提 PR → 人合并 | 只读，且必须遵守 |
| [GLOSSARY.md](GLOSSARY.md) | 领域词汇与流程词的唯一来源 | 只读；要造词先改这里 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块边界、依赖方向、HTTP/SSE 契约、数据模型、红线归属 | 只读；改形状要先改它 + ADR |
| [docs/adr/](docs/adr/) | 已落地的架构决策（0001–0006） | 新增；不改旧文 |
| [docs/ai-companion-spec.md](docs/ai-companion-spec.md) | 上游封板决策（数据来自产品侧） | 只读 |
| [主动陪伴AI聊天助手_PRD_V1.0.md](主动陪伴AI聊天助手_PRD_V1.0.md) | PRD（按需 grep 章节） | 只读 |
| [prototype/](prototype/) | 已验收的原型（视觉与文案基线） | 只读；要改先问人 |
| [.scratch/proactive-companion-runtime/](.scratch/proactive-companion-runtime/) | 本地 tracker：`spec.md` + `issues/NN-*.md` | 读写（关票按 issue-tracker 约定） |
| [docs/agents/domain.md](docs/agents/domain.md) | 领域文档约定（GLOSSARY/ADR 格式） | 只读（改要 `R-08-A7`） |
| [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) | 票放哪、状态词、怎么关票 | 只读（改要 `R-08-A7`） |
| [.specify/](.specify/) | speckit 模板与空 constitution | 只读；`memory/constitution.md` 是未填充模板，不是规则源 |
| `.dsh/`、`.opencode/` | 工具侧技能与命令配置 | 只读；**新增本项目 skill 除外**（走 PR） |
| `src/`、`web/`、`test/`、`tools/` | 代码 | 读写 |
| [.github/](.github/) | CI 门禁 `workflows/ci.yml` + PR 模板 | 只读；改门禁要先问人（R-08-A8） |
| `data/` | 运行时生成：`companion.db`、`cards/`、`avatars/`、`logs/`、`config.json`、`runtime.json` | **不提交、不手工编辑、不读真实用户数据** |

**不在上表里的根目录文件**：`Coding阶段总结.md` 是复盘（不是约束）；`.repro*`、`NUL`、`mp-scan-watch/` 不是本项目产物，不提交、不引用。

**工具侧注意**：OpenCode 只加载 `.opencode/`，**不读 `.dsh/`**。`/fix-bug`、`/gate` 这类项目命令只是入口提示，正文要显式 `Read` 对应 `.dsh/skills/<name>/SKILL.md`。

## A-03 读文件顺序（唯一一份）

1. **A-03-01** 本文件 + [Rule.md](Rule.md)：先知道什么不许干。
2. **A-03-02** 分流（看命令，不看判断）：
   - 打了 `/fix-bug` → 读 `.dsh/skills/fix-bug/SKILL.md`，**不读票**。
   - 没打，且已有当前票 → 读 `.scratch/proactive-companion-runtime/issues/NN-*.md`。
   - 没打，且还没有票 → 先按 [Workflow.md](Workflow.md) W-13-3 补一张 `ready-for-agent` 的票，再读它。
3. **A-03-03** spec 对应节：`.scratch/proactive-companion-runtime/spec.md` 的该票涉及段落 + `Implementation Decisions` 里相关 `D-*`。
4. **A-03-04** [ARCHITECTURE.md](docs/ARCHITECTURE.md) AR-04（模块契约）、AR-06（HTTP 契约）、AR-08（红线归属）；按改动面再补 AR-03、AR-05、AR-07、AR-09、AR-11。
5. **A-03-05** 需要时：[GLOSSARY.md](GLOSSARY.md)（用词）、[docs/adr/](docs/adr/)（为什么这样）、PRD 具体章节（grep 章节号，不整篇读）、[prototype/index.html](prototype/index.html)（只看不改）。

代理不许自己切通道；判据见 [Workflow.md](Workflow.md) W-01。

写 spec / 票时另读 [docs/agents/domain.md](docs/agents/domain.md) 与 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)；运行期读序以本节为准。

冲突按 [Rule.md](Rule.md) 头部的优先级裁决；裁决不了就停下问人，不要自己发明规则。

## A-04 命令

**唯一事实源是 `package.json`**；下表只列常用入口，不展开实现（展开会漂移）。

| 用途 | 命令 |
|---|---|
| 启动（前台） | `npm start` |
| 开发（改文件自动重启） | `npm run dev` |
| 全量测试 | `npm test` |
| 只跑一个缝 | `npm run test:s1` / `test:s2` / `test:s3` |
| 单文件 | `node --test <file>` |
| 起假 LLM（人工联调） | `npm run fake-llm` |
| 静态自检 | `npm run check` |
| 冒烟（起进程→/health→退出） | `npm run smoke` |
| 重置本地数据 | `npm run db:reset`（备份后删库；**先确认人同意**） |
| 收尾流水线（检查/合规/提交/PR） | `node tools/gate.js`（判据见 `.dsh/skills/gate/SKILL.md`） |
| 崩溃节流守护（Windows） | `pwsh -File tools/run-companion.ps1` |

命令名与参数以 `package.json` 为准。测试约定：一次真实进程 = 临时 `DATA_DIR` + 随机端口；禁止 `sleep > 2s`；禁止断言内部函数与表结构（ADR-0004）。

## A-05 硬规则（只有两条，其余见 Rule）

1. **A-05-01** 不写任何注释；解释只进 commit message / PR body / 票 Notes（R-03-05、R-07-23）。
2. **A-05-02** `main` 只接受合并；代理不 `gh pr merge`、不直推 `main`（R-07-22）。

## A-06 子代理与并行

照 [Workflow.md](Workflow.md) W-13-4 执行：任务说明必须包含"先读 AGENTS 与 Rule"、票号、验收命令；子代理同样受本文约束，**不许**决定架构形状或新增依赖，**不许**自己开 PR 或合并；门禁由主线程重跑，它自己跑绿不算数。
