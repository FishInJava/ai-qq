# Rule.md — 项目约束

> 本文件是硬约束，不是建议。与其它文档冲突时：**Rule.md > docs/ARCHITECTURE.md > spec > PRD > prototype**。
> 违反本文件的改动即视为未完成，不允许以"能跑"为理由合入。任何要突破的条目，先改本文件并取得人同意。

---

## R-01 架构边界（违反即架构破坏）

### R-01-1 依赖方向

依赖方向图与模块契约以 [docs/ARCHITECTURE.md AR-04-1](docs/ARCHITECTURE.md) 为唯一来源，本文件不复制那张图。这里只保留**不可越过的反向边**：

**禁止的反向边**：业务模块 → `http/*`；任何模块 → `web/*`；`store` → `llm`；`llm` → 业务模块；`cards` → `chat`。

### R-01-2 五条"只有一个"

| 唯一 | 含义 | 审查手段 |
|---|---|---|
| `store` 唯一 SQL 触点 | 业务模块拿不到 `db`，只经 `repo/*`；跨表写在 `store.tx()` | grep `MATCH\|SELECT\|INSERT\|UPDATE\|DELETE` 出现在 `src/store` 之外 |
| `clock` 唯一时间源 | 除 `clock`/`schedule` 外禁止 `Date.now()`/`new Date()`/`setTimeout`/`setInterval`/`Date.parse` | `npm run check` |
| `runTick` 唯一调度实现 | 没有第二套模拟调度；定时器只是壳 | 代码评审 |
| `http` 唯一说人话处 | 业务模块抛 `AppError(code)`，中文文案与状态码只在 `http` 映射 | 代码评审 + grep 中文串 |
| `bus` 单向广播 | 业务模块 emit，不关心 SSE；`http` 订阅转发 | 代码评审 |

### R-01-3 页面边界

`web/` 内禁止：任何 SQL/数据库概念、任何定时调度逻辑、任何 LLM 调用、把业务状态当权威（刷新后必须以后端为准）。

### R-01-4 契约即接口

`docs/ARCHITECTURE.md AR-06` 的 HTTP/SSE 表就是对外契约。改它必须同时：改 `web/`、改 `test/s1`、更新 AR-06 那张表，并且**先问人**。

---

## R-02 技术栈（锁定，不得自行更换）

| 层 | 选定 | 备注 |
|---|---|---|
| 运行时 | Node.js ≥ 24（本机 v24.11.1），ESM，`"type":"module"` | 无 TS、无转译、无打包 |
| HTTP | `node:http` 自建路由 | 禁止 Express/Koa/Fastify |
| 存储 | `node:sqlite`（`DatabaseSync`），WAL，单文件 `data/companion.db` | 换库只改 `src/store`（ADR-0002） |
| 前端 | 单页 HTML + 原生 ES module + 手写 CSS | 禁止框架、禁止打包器、禁止 CDN 资源 |
| 测试 | `node:test` + 内置 `fetch` + `child_process` | 禁止 vitest/jest/playwright |
| 模型 | 单一 OpenAI 兼容端点（`base_url`/`api_key`/`chat_model`/`utility_model`） | 禁止多供应商与回退 |
| 托盘/自启 | PowerShell + WinForms 辅助进程 + 启动项（ADR-0006） | 禁止 Electron/Tauri |
| 日志 | 自建 `runtime/log`（`data/logs/app-YYYYMMDD.log` 10MB 轮转 7 天 + `events.jsonl`） | 禁止第三方 logger |

**版本策略**：只有 `package.json` 的 `engines.node >= 24` 与 `packageManager` 字段；不引入任何 `dependencies`。

---

## R-03 编码规范

### R-03-1 通用

- **R-03-01** 文件命名 `kebab-case.js`；导出用命名导出（`export function`/`export const`），默认导仅用于模块工厂（如 `createLlm`）。
- **R-03-02** 一个文件一个职责，超过 ~300 行先想是不是两个模块。
- **R-03-03** 函数参数超过 3 个用对象；公开函数的入参、返回、抛错码靠签名与命名表达，不写 JSDoc。
- **R-03-04** 纯函数优先：能不在函数里读写外部状态的，就别读。副作用集中在 `store`/`llm`/`http`/`clock` 调用点。
- **R-03-05** 一律不写注释：代码里不允许出现任何注释（行注释、块注释、JSDoc、HTML/CSS/SQL/PowerShell 注释）。要解释的写进 commit message、PR body 或票 Notes；`npm run check` 会拦。历史迁移 SQL 例外（R-05-01「只追加、不改旧文件」）。
- **R-03-06** 时间一律 `clock.iso()`；金额/额度用整数；不做浮点累加。

### R-03-2 错误

- **R-03-07** 业务错误一律 `AppError`：`{ code, message, retryable, status }`；`message` 是给界面的中文，不含堆栈/密钥/供应商原文。
- **R-03-08** 业务模块不 `console.*`，只 `log.info/warn/error` 或抛 `AppError`。
- **R-03-09** `catch` 必须处理或带上上下文重抛；禁止空 `catch {}`。
- **R-03-10** 未捕获异常：顶层记录后 `exit(42)`，重启由守护脚本节流（ADR-0006）。

### R-03-3 异步与并发

- **R-03-11** 会话级写操作走内存互斥（`Map<sessionId, Promise>`），第二个请求 409 `busy`。
- **R-03-12** tick 有全局 `tickRunning` 标志，重叠直接跳过本次，不排队。
- **R-03-13** 异步记忆管线（事实/摘要）永不阻塞回复；失败只记日志。
- **R-03-14** 所有 LLM 调用带超时；禁止无限等待。

### R-03-4 日志与埋点

- **R-03-15** 事件名与属性严格照 PRD 4.2 表（`app_start`…`feed_fetch`），不新增不改名；要加先改 PRD 对应表并问人。
- **R-03-16** 日志里不写卡片全文、不写消息全文、不写 `api_key`；只写 id、长度、耗时、决策原因。
- **R-03-17** `decision_reason` 用稳定英文枚举（`state_not_active` 等），界面文案在 `web/` 映射，不反向翻译。

### R-03-5 测试

- **R-03-18** 用例名写"用户看到什么"，不写"调用了哪个方法"。
- **R-03-19** 只走 S1/S2/S3 三个缝；不断言内部函数、表结构、日志文本。
- **R-03-20** 禁止 `sleep > 2s`；禁止真实等 20 分钟；时间一律推进假时钟。
- **R-03-21** 每个 P0 红线（T1–T11、T13–T16）至少一条自动化用例；T12 人工周测不进 CI。
- **R-03-22** 不许 `skip`、`only`、注释断言、放宽阈值来换绿。

用例落哪个缝、先红后绿怎么跑，见 [Workflow.md](Workflow.md) W-06；本节只定判定标准。

---

## R-04 依赖使用

1. **R-04-01** 运行时零依赖（ADR-0002）。只允许 `node:` 内置模块。
2. **R-04-02** 新增任何第三方包（含 devDependency）必须：改 ADR-0002（或新增 successor ADR）→ 取得人同意 → 在 `package.json` 固定版本并提交 lockfile。
3. **R-04-03** 禁止为"少写 20 行"引入包（多段表单解析、SSE 拼帧、事件总线、日志、深拷贝、UUID 等一律自己写）。
4. **R-04-04** 禁止 CDN/外链加载前端资源；页面必须离线可用（T11/T14 的隐含前提）。
5. **R-04-05** 禁止 `npx` 拉临时工具改代码；脚本进 `tools/`。

---

## R-05 数据与迁移

- **R-05-01** 迁移文件 `src/store/migrations/NNNN-<slug>.sql`，只追加、不改旧文件；`schema_version` 由迁移事务更新。
- **R-05-02** 表结构以 `docs/ARCHITECTURE.md AR-05` 为准；spec D-14 的三处修正（`life_events` 去联合唯一、`sessions.state` 加 `unstarted`、`daily_budget` 改 `(date, session_id, used)`）**必须生效**，不许照 PRD 原表实现。
- **R-05-03** 时间列 UTC ISO8601；三列本地日期（`life_events.event_date`、`daily_budget.date`、`world_feeds.date`）只由 `clock.localDay()` 产出。
- **R-05-04** 写操作必须事务；`token_used` 与 `token_ledger` 必须同事务落库，账本单调，续额只提高 `limit`。
- **R-05-05** 删除策略：`scope=card` 保留会话与记录；`scope=records` 先置 `paused` 再级联；**任何删除路径都要能回滚到备份**。
- **R-05-06** 生命周期：`scheduler_state` 180 天、`world_feeds` 90 天；`messages` 永不自动删。

---

## R-06 安全要求

本表是**要求**；每条的代码落点见 [docs/ARCHITECTURE.md AR-10](docs/ARCHITECTURE.md)。改要求改本节，改落点改那张表。

| # | 要求 |
|---|---|
| R-06-S1 | HTTP 只监听 `127.0.0.1`；校验 `Host`，非本机来源 403（防 DNS rebinding） |
| R-06-S2 | `api_key` 只存 `data/config.json`；接口只回后四位；日志/事件/错误全量脱敏 |
| R-06-S3 | 与模型/抓取源通信必须 HTTPS；模型无权联网（不予工具调用） |
| R-06-S4 | 卡片文本作为**数据**注入（`<card_data>` 块 + 角色标注），绝不进指令位；卡片里的"忽略以上指令"不生效 |
| R-06-S5 | 上传仅 `.png`/`.json` 且 ≤20MB；预览令牌 TTL 5min 一次性；解析失败不落库 |
| R-06-S6 | 任何用户输入不拼进文件系统路径；导出文件名白名单化 |
| R-06-S7 | 清空数据需 `confirm:"DELETE"`；删卡需二次确认 + `scope` |
| R-06-S8 | 出网只有 `llm` 与 `living/feeds`；新增出网点必须问人 |
| R-06-S9 | 日志不落卡片全文与消息全文；崩溃现场只落堆栈与 id |

跨文档引用写作 `R-06-S1`…`R-06-S9`。

---

## R-07 明确禁止事项（写下来是为了不用争论）

**产品红线**
1. **R-07-01** 给风格四条判据做开关/选项/滑杆。
2. **R-07-02** 让角色说出额度、配额、余额、token、error、"作为 AI"。
3. **R-07-03** 加"主动消息已发送"之类标签；主动消息与普通消息必须同渲染。
4. **R-07-04** 主动消息无锚点发送；锚定校验失败还扣预算。
5. **R-07-05** 把预算/log 里的系统信息插值进对话。
6. **R-07-06** UI 上出现 Paused/Dormant/unstarted 英文或"暂停/耗尽"字样。

**技术红线**
7. **R-07-07** 引入前端框架/打包器/TS 构建链。
8. **R-07-08** 引入 Electron/Tauri 或安装器。
9. **R-07-09** 引入向量库/嵌入检索。
10. **R-07-10** 多供应商路由、自动回退、备用通道、"降级模型"。
11. **R-07-11** 执行卡片里的正则/STscript；注入世界书。
12. **R-07-12** 推送通道（Web Push/Telegram/桌面通知）。
13. **R-07-13** 把 tick 决策写进浏览器；页面定时刷新产物。
14. **R-07-14** 在 `src/**` 里裸用时间 API 或 `console.*`。
15. **R-07-15** 让业务模块 import `http/*`。
16. **R-07-16** 直接把 SQL 写在业务模块里。
17. **R-07-17** 修改 `prototype/`、PRD、`docs/ai-companion-spec.md` 来迁就实现。
18. **R-07-18** 手工编辑 `data/companion.db` 或提交 `data/`。
19. **R-07-19** 以 `skip`/`only`/注释断言/放宽阈值让测试变绿。
20. **R-07-20** 在测试里 `sleep` 超过 2 秒或等真实 20 分钟。
21. **R-07-21** 改 `.github/workflows/ci.yml` 让红变绿（删步骤、加 `continue-on-error`、`|| true`、缩 matrix、改门禁命令）。
22. **R-07-22** 直推 `main`（纯文档错别字除外）或自己合并 PR。
23. **R-07-23** 在代码里写注释（含 JSDoc、行尾注释、块注释）；解释只进 commit message / PR body / 票 Notes。

---

## R-08 必须先征得人类同意（不要自己拍板）

| # | 操作 | 为什么必须问 |
|---|---|---|
| R-08-A1 | 新增/替换任何第三方依赖（含 dev） | 零依赖是本项目的基础设施决策（ADR-0002） |
| R-08-A2 | 改 `docs/ARCHITECTURE.md AR-06` 对外契约（HTTP/SSE 路由、字段、事件名） | 会连带 `web/`、`test/s1`，且影响兼容 |
| R-08-A3 | 改数据模型（表/列/约束/索引）或新增迁移 | 关系到已有用户数据与无损导出 |
| R-08-A4 | 删除或重写 `data/` 下任何内容（`db:reset`、清库、删卡批量） | 不可逆 |
| R-08-A5 | 改产品红线文案与红线行为（系统腔词表、三态叙事词、锚定校验规则） | 这是产品差异化的全部 |
| R-08-A6 | 推翻任何已有 ADR（改技术栈、加 Electron、加向量库、加多供应商） | 架构变更 |
| R-08-A7 | 触碰 `prototype/`、PRD、`docs/ai-companion-spec.md`、`docs/agents/` | 上游产物，不是实现可以改的 |
| R-08-A8 | 改测试栈、测试缝、CI 门禁（加 runner、改 S1–S3 定义、改 `.github/workflows/ci.yml` 的步骤/matrix/门禁命令） | 会让"绿"失去意义 |
| R-08-A9 | 监听地址/端口范围变化（非 `127.0.0.1`、非 3000+1 重试） | 安全面变化 |
| R-08-A10 | 新增出网点（除 `llm` 与白名单 feeds） | 隐私与成本 |
| R-08-A11 | 任何"临时绕过"（注释掉红线检查、开关默认关闭红线行为、硬编码测试数据进生产路径） | 临时即永久 |
| R-08-A12 | 提交/推送/发布、改版本号、改 `package.json` 的 scripts 名 | 对外影响 |
| R-08-A13 | 合并 PR、改分支保护规则、改仓库可见性 | 主干与仓库的归属权，只有人能决定 |

跨文档引用写作 `R-08-A1`…`R-08-A13`；`gate` 的 `--consent=A7` 是同一编号的短写。

提问格式：说清"要改什么 / 为什么必须改 / 不改的代价 / 影响哪些文件与验收项"，等人回答再动。

---

## R-09 合并前自检清单（判定，不重复步骤）

1. **R-09-01** `npm test` 全绿、`npm run check` 无输出、`npm run smoke` 退出码 0；**CI 在 `ubuntu-latest` 与 `windows-latest` 上都绿**。本地绿但 CI 红，按红处理。
2. **R-09-02** 改动在 `ticket-NN-<slug>` 或 `fix-<slug>` 分支上，PR 已按对应模板填好；**合并由人点**，代理不自己合。
3. **R-09-03** 新增文件在正确目录（ARCHITECTURE AR-03"不许放什么"）。
4. **R-09-04** 没有新增反向依赖边、没有裸时间 API、没有裸 SQL、没有 `console.*`、没有注释。
5. **R-09-05** 碰了红线（R-07）没有？碰了契约（AR-06 那张表 / R-08-A2）有没有三处同步？
6. **R-09-06** 改动是否需要 R-08 的同意？需要就先别合。
7. **R-09-07** 票：验收项全勾、`Status: done`、`## Notes` 写了偏差与遗留。bug：无票，commit body 四段 + PR body 五段，两处缺一不可。
8. **R-09-08** 配置 schema 没有偷偷长出"风格开关"之类的东西。

命令与执行顺序见 [Workflow.md](Workflow.md) W-07、W-09、W-10；本节只回答"能不能合"。
