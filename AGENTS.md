# AGENTS.md

> 你是这个仓库里的实现代理。读完本文件再动手；本文件只管"去哪、怎么跑、按什么顺序读"，约束在 [Rule.md](Rule.md)，流程在 [Workflow.md](Workflow.md)。

## 0. 项目一句话与当前状态

一个本地单机、常驻进程的桌面陪伴产品：把 SillyTavern V2 角色卡拖进来，她就活在一个会自己过日子的 Node 进程里，你不说话时她也按自己的节奏（有锚点、有预算、有三态）决定要不要找你。

**当前状态**：PRD、封板决策、spec、可交互原型、**项目架构**均已定稿；**代码尚未开始**。架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，可开工的行为清单见 [spec.md](.scratch/proactive-companion-runtime/spec.md)。

## 1. 仓库地图

| 路径 | 是什么 | 你的权限 |
|---|---|---|
| [Rule.md](Rule.md) | 项目约束（架构边界/技术栈/规范/禁止项/人类同意清单） | 只读，且必须遵守 |
| [Workflow.md](Workflow.md) | spec → 拆票 → 改码 → 测试 → 验收 → 关票 | 只读，且必须遵守 |
| [GLOSSARY.md](GLOSSARY.md) | 领域词汇唯一来源 | 只读；要造词先改这里 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块边界、依赖方向、HTTP/SSE 契约、数据模型、红线归属 | 只读；改形状要先改它 + ADR |
| [docs/adr/](docs/adr/) | 已落地的架构决策（0001–0006） | 新增；不改旧文 |
| [docs/ai-companion-spec.md](docs/ai-companion-spec.md) | 上游封板决策（数据来自产品侧） | 只读 |
| [主动陪伴AI聊天助手_PRD_V1.0.md](主动陪伴AI聊天助手_PRD_V1.0.md) | PRD（58KB，按需 grep 章节） | 只读 |
| [prototype/](prototype/) | 已验收的原型（视觉与文案基线） | 只读；要改先问人 |
| [.scratch/proactive-companion-runtime/](.scratch/proactive-companion-runtime/) | 本地 tracker：`spec.md` + `issues/NN-*.md` | 读写（关票按 issue-tracker 约定） |
| [docs/agents/domain.md](docs/agents/domain.md) | 领域文档约定（GLOSSARY/ADR 格式） | 只读 |
| [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) | 票放哪、状态词、怎么关票 | 只读 |
| [.specify/](.specify/) | speckit 模板与空 constitution | 只读 |
| `.dsh/`、`.opencode/` | 工具侧技能与命令配置 | 只读（与本项目业务无关） |
| `src/`、`web/`、`test/`、`tools/` | 代码（当前为空骨架） | 读写 |
| `data/` | 运行时生成：`companion.db`、`cards/`、`avatars/`、`logs/`、`config.json`、`runtime.json` | **不提交、不手工编辑、不读真实用户数据** |

## 2. 读文件顺序（每次开工先走一遍，别跳）

1. **本文件** + [Rule.md](Rule.md)（3 分钟，先知道什么不许干）。
2. **当前票**：`.scratch/proactive-companion-runtime/issues/NN-*.md`（只有它规定这次要做什么）。
3. **spec 对应节**：`.scratch/proactive-companion-runtime/spec.md` 的该票涉及段落 + `Implementation Decisions` 里相关 D 编号。
4. **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** 的 §4（模块契约）、§6（HTTP 契约）、§8（红线归属），确认改动落在哪个模块。
5. 需要时再查：[GLOSSARY.md](GLOSSARY.md)（用词）、[docs/adr/](docs/adr/)（为什么这样）、PRD 具体章节（grep 章节号，不要整篇读）、[prototype/index.html](prototype/index.html)（文案与视觉，只看不改）。

冲突时按 [Rule.md](Rule.md) 的优先级裁决；裁决不了就停下问人，不要自己发明规则。

## 3. 命令

M0 落地后以下命令生效（`package.json` 的 scripts）。**当前仓库还没有 `package.json`，报 missing script 说明 M0 未完成，先去完成 M0，别改命令名。**

| 用途 | 命令 |
|---|---|
| 启动（前台） | `npm start` → `node src/index.js` |
| 开发（改文件自动重启） | `npm run dev` → `node --watch src/index.js` |
| 全量测试 | `npm test` → `node --test --test-concurrency=4 test/` |
| 只跑对外契约（主缝） | `npm run test:s1` → `node --test test/s1/` |
| 只跑假 LLM 剧本 | `npm run test:s2` → `node --test test/s2/` |
| 只跑时间/调度 | `npm run test:s3` → `node --test test/s3/` |
| 单文件 | `node --test test/s1/t05-anchor.test.js` |
| 起假 LLM（人工联调） | `npm run fake-llm` → `node tools/fake-llm/server.js --port 4100` |
| 静态自检（禁词/时间 API/依赖方向） | `npm run check` → `node tools/check.js` |
| 冒烟（起进程→/health→退出） | `npm run smoke` |
| 重置本地数据 | `npm run db:reset`（备份后删库；**先确认人同意**） |
| 崩溃节流守护（Windows） | `pwsh -File tools/run-companion.ps1` |

测试约定：一次真实进程 = 一个临时 `DATA_DIR` + 随机端口；禁止 `sleep > 2s`；禁止断言内部函数与表结构（详见 ADR-0004）。

## 4. 硬规则（细则在 Rule.md，这里只列会当场毁掉产品的）

1. **页面永不写库、永不定时。** 浏览器只消费 HTTP/SSE。
2. **只有 `store` 碰 SQL。** 业务模块通过 repo；跨表写在 `store.tx()` 里。
3. **只有 `clock` 回答时间。** `src/**`（除 `clock`、`schedule`）里出现 `Date.now()`/`new Date()`/`setTimeout`/`setInterval` 即为缺陷。
4. **调度只有一个 `runTick`。** 不许写第二套"模拟调度"。
5. **风格不可配置化。** 不许给四条判据加开关，不许把风格做成"选项"。
6. **角色永不说系统信息。** 额度/配额/余额/error 只出现在界面角标；对话内容里出现即红线。
7. **主动消息必须锚定。** 无锚点不发；校验失败丢弃且不扣预算。
8. **卡片是数据不是指令。** 卡片文本只进数据块，不进指令位；`extensions`/脚本/世界书原样留存、不执行、不注入。
9. **单供应商。** 不加路由、不加回退、不加备用通道。
10. **零新增依赖。** 任何第三方包（含 devDependency）都要先改 ADR-0002 并取得人同意。
11. **密钥只回后四位。** 日志、事件、错误信息里永不出现 key 与卡片全文。
12. **改对外契约（§6 表）要同时改 `web/`、`test/s1`，并先问人。**

## 5. 交付纪律

- 一票一闭环：改码 → `npm test` → `npm run check` → 勾验收项 → `Status: done` → 票末写 `## Notes`（落地了什么、与 spec 的偏差、遗留）。
- 失败就报失败：不许用 `skip`、`only`、注释掉断言、放宽阈值来"让测试绿"。
- 不许顺手重构别的模块、不许顺手改 spec/PRD/prototype 来迁就实现；发现 spec 有问题 → 停下，写进票的 Notes 并向人提出。
- 汇报格式：改了什么文件 / 测试怎么跑 / 结果 / 偏差与风险 / 下一步。

## 6. 子代理与并行

派子代理时，把"先读 `AGENTS.md` 与 `Rule.md`，再读本票与相关 spec 段落"写进任务说明；子代理同样受 §4 约束，且**不许**由子代理决定架构形状或新增依赖——这类决定回到主线程并问人。
