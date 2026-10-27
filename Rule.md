# Rule.md — 项目约束

> 本文件是硬约束，不是建议。与其它文档冲突时：**Rule.md > docs/ARCHITECTURE.md > spec > PRD > prototype**。
> 违反本文件的改动即视为未完成，不允许以"能跑"为理由合入。任何要突破的条目，先改本文件并取得人同意。

---

## 1. 架构边界（违反即架构破坏）

### 1.1 依赖方向

```
runtime ──> http, schedule, living, store, session, bus
http    ──> 业务模块（只调公开函数）, bus
schedule──> proactive, session, store, clock, bus
proactive─> memory, living(读), llm, quota, store, clock, bus
chat    ──> style, memory, llm, quota, session(读), store, clock, bus
session ──> store, quota, clock, bus
memory  ──> llm, store, clock
cards   ──> store, clock
library ──> store, session, quota
living  ──> llm, store, clock, feeds 抓取器
quota   ──> store, clock
llm     ──> clock（超时）
store   ──> 无（时间戳由调用方传入）
clock   ──> 无
bus     ──> 无
```

**禁止的反向边**：业务模块 → `http/*`；任何模块 → `web/*`；`store` → `llm`；`llm` → 业务模块；`cards` → `chat`。

### 1.2 五条"只有一个"

| 唯一 | 含义 | 审查手段 |
|---|---|---|
| `store` 唯一 SQL 触点 | 业务模块拿不到 `db`，只经 `repo/*`；跨表写在 `store.tx()` | grep `MATCH\|SELECT\|INSERT\|UPDATE\|DELETE` 出现在 `src/store` 之外 |
| `clock` 唯一时间源 | 除 `clock`/`schedule` 外禁止 `Date.now()`/`new Date()`/`setTimeout`/`setInterval`/`Date.parse` | `npm run check` |
| `runTick` 唯一调度实现 | 没有第二套模拟调度；定时器只是壳 | 代码评审 |
| `http` 唯一说人话处 | 业务模块抛 `AppError(code)`，中文文案与状态码只在 `http` 映射 | 代码评审 + grep 中文串 |
| `bus` 单向广播 | 业务模块 emit，不关心 SSE；`http` 订阅转发 | 代码评审 |

### 1.3 页面边界

`web/` 内禁止：任何 SQL/数据库概念、任何定时调度逻辑、任何 LLM 调用、把业务状态当权威（刷新后必须以后端为准）。

### 1.4 契约即接口

`docs/ARCHITECTURE.md §6` 的 HTTP/SSE 表就是对外契约。改它必须同时：改 `web/`、改 `test/s1`、更新 §6 表，并且**先问人**。

---

## 2. 技术栈（锁定，不得自行更换）

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

## 3. 编码规范

### 3.1 通用

- 文件命名 `kebab-case.js`；导出用命名导出（`export function`/`export const`），默认导仅用于模块工厂（如 `createLlm`）。
- 一个文件一个职责，超过 ~300 行先想是不是两个模块。
- 函数参数超过 3 个用对象；公开函数的入参、返回、抛错码靠签名与命名表达，不写 JSDoc。
- 纯函数优先：能不在函数里读写外部状态的，就别读。副作用集中在 `store`/`llm`/`http`/`clock` 调用点。
- **一律不写注释**：代码里不允许出现任何注释（行注释、块注释、JSDoc、HTML/CSS/SQL/PowerShell 注释）。要解释的写进 commit message、PR body 或票 Notes；`npm run check` 会拦。历史迁移 SQL 例外（§5「只追加、不改旧文件」）。
- 时间一律 `clock.iso()`；金额/额度用整数；不做浮点累加。

### 3.2 错误

- 业务错误一律 `AppError`：`{ code, message, retryable, status }`；`message` 是给界面的中文，不含堆栈/密钥/供应商原文。
- 业务模块不 `console.*`，只 `log.info/warn/error` 或抛 `AppError`。
- `catch` 必须处理或带上上下文重抛；禁止空 `catch {}`。
- 未捕获异常：顶层记录后 `exit(42)`，重启由守护脚本节流（ADR-0006）。

### 3.3 异步与并发

- 会话级写操作走内存互斥（`Map<sessionId, Promise>`），第二个请求 409 `busy`。
- tick 有全局 `tickRunning` 标志，重叠直接跳过本次，不排队。
- 异步记忆管线（事实/摘要）永不阻塞回复；失败只记日志。
- 所有 LLM 调用带超时；禁止无限等待。

### 3.4 日志与埋点

- 事件名与属性严格照 PRD 4.2 表（`app_start`…`feed_fetch`），不新增不改名；要加先改 PRD 对应表并问人。
- 日志里不写卡片全文、不写消息全文、不写 `api_key`；只写 id、长度、耗时、决策原因。
- `decision_reason` 用稳定英文枚举（`state_not_active` 等），界面文案在 `web/` 映射，不反向翻译。

### 3.5 测试

- 用例名写"用户看到什么"，不写"调用了哪个方法"。
- 只走 S1/S2/S3 三个缝；不断言内部函数、表结构、日志文本。
- 禁止 `sleep > 2s`；禁止真实等 20 分钟；时间一律推进假时钟。
- 每个 P0 红线（T1–T11、T13–T16）至少一条自动化用例；T12 人工周测不进 CI。
- 不许 `skip`、`only`、注释断言、放宽阈值来换绿。

---

## 4. 依赖使用

1. **运行时零依赖**（ADR-0002）。只允许 `node:` 内置模块。
2. 新增任何第三方包（含 devDependency）必须：改 ADR-0002（或新增 successor ADR）→ 取得人同意 → 在 `package.json` 固定版本并提交 lockfile。
3. 禁止为"少写 20 行"引入包（多段表单解析、SSE 拼帧、事件总线、日志、深拷贝、UUID 等一律自己写）。
4. 禁止 CDN/外链加载前端资源；页面必须离线可用（T11/T14 的隐含前提）。
5. 禁止 `npx` 拉临时工具改代码；脚本进 `tools/`。

---

## 5. 数据与迁移

- 迁移文件 `src/store/migrations/NNNN-<slug>.sql`，只追加、不改旧文件；`schema_version` 由迁移事务更新。
- 表结构以 `docs/ARCHITECTURE.md §5` 为准；spec D-14 的三处修正（`life_events` 去联合唯一、`sessions.state` 加 `unstarted`、`daily_budget` 改 `(date, session_id, used)`）**必须生效**，不许照 PRD 原表实现。
- 时间列 UTC ISO8601；三列本地日期（`life_events.event_date`、`daily_budget.date`、`world_feeds.date`）只由 `clock.localDay()` 产出。
- 写操作必须事务；`token_used` 与 `token_ledger` 必须同事务落库，账本单调，续额只提高 `limit`。
- 删除策略：`scope=card` 保留会话与记录；`scope=records` 先置 `paused` 再级联；**任何删除路径都要能回滚到备份**。
- 生命周期：`scheduler_state` 180 天、`world_feeds` 90 天；`messages` 永不自动删。

---

## 6. 安全要求

| # | 要求 |
|---|---|
| S1 | HTTP 只监听 `127.0.0.1`；校验 `Host`，非本机来源 403（防 DNS rebinding） |
| S2 | `api_key` 只存 `data/config.json`；接口只回后四位；日志/事件/错误全量脱敏 |
| S3 | 与模型/抓取源通信必须 HTTPS；模型无权联网（不予工具调用） |
| S4 | 卡片文本作为**数据**注入（`<card_data>` 块 + 角色标注），绝不进指令位；卡片里的"忽略以上指令"不生效 |
| S5 | 上传仅 `.png`/`.json` 且 ≤20MB；预览令牌 TTL 5min 一次性；解析失败不落库 |
| S6 | 任何用户输入不拼进文件系统路径；导出文件名白名单化 |
| S7 | 清空数据需 `confirm:"DELETE"`；删卡需二次确认 + `scope` |
| S8 | 出网只有 `llm` 与 `living/feeds`；新增出网点必须问人 |
| S9 | 日志不落卡片全文与消息全文；崩溃现场只落堆栈与 id |

---

## 7. 明确禁止事项（写下来是为了不用争论）

**产品红线**
1. 给风格四条判据做开关/选项/滑杆。
2. 让角色说出额度、配额、余额、token、error、"作为 AI"。
3. 加"主动消息已发送"之类标签；主动消息与普通消息必须同渲染。
4. 主动消息无锚点发送；锚定校验失败还扣预算。
5. 把预算/log 里的系统信息插值进对话。
6. UI 上出现 Paused/Dormant/unstarted 英文或"暂停/耗尽"字样。

**技术红线**
7. 引入前端框架/打包器/TS 构建链。
8. 引入 Electron/Tauri 或安装器。
9. 引入向量库/嵌入检索。
10. 多供应商路由、自动回退、备用通道、"降级模型"。
11. 执行卡片里的正则/STscript；注入世界书。
12. 推送通道（Web Push/Telegram/桌面通知）。
13. 把 tick 决策写进浏览器；页面定时刷新产物。
14. 在 `src/**` 里裸用时间 API 或 `console.*`。
15. 让业务模块 import `http/*`。
16. 直接把 SQL 写在业务模块里。
17. 修改 `prototype/`、PRD、`docs/ai-companion-spec.md` 来迁就实现。
18. 手工编辑 `data/companion.db` 或提交 `data/`。
19. 以 `skip`/`only`/注释断言/放宽阈值让测试变绿。
20. 在测试里 `sleep` 超过 2 秒或等真实 20 分钟。
21. 改 `.github/workflows/ci.yml` 让红变绿（删步骤、加 `continue-on-error`、`|| true`、缩 matrix、改门禁命令）。
22. 直推 `main`（纯文档错别字除外）或自己合并 PR。
23. 在代码里写注释（含 JSDoc、行尾注释、块注释）；解释只进 commit message / PR body / 票 Notes。

---

## 8. 必须先征得人类同意（不要自己拍板）

| # | 操作 | 为什么必须问 |
|---|---|---|
| A1 | 新增/替换任何第三方依赖（含 dev） | 零依赖是本项目的基础设施决策（ADR-0002） |
| A2 | 改 `docs/ARCHITECTURE.md §6` 对外契约（HTTP/SSE 路由、字段、事件名） | 会连带 `web/`、`test/s1`，且影响兼容 |
| A3 | 改数据模型（表/列/约束/索引）或新增迁移 | 关系到已有用户数据与无损导出 |
| A4 | 删除或重写 `data/` 下任何内容（`db:reset`、清库、删卡批量） | 不可逆 |
| A5 | 改产品红线文案与红线行为（系统腔词表、三态叙事词、锚定校验规则） | 这是产品差异化的全部 |
| A6 | 推翻任何已有 ADR（改技术栈、加 Electron、加向量库、加多供应商） | 架构变更 |
| A7 | 触碰 `prototype/`、PRD、`docs/ai-companion-spec.md`、`docs/agents/` | 上游产物，不是实现可以改的 |
| A8 | 改测试栈、测试缝、CI 门禁（加 runner、改 S1–S3 定义、改 `.github/workflows/ci.yml` 的步骤/matrix/门禁命令） | 会让"绿"失去意义 |
| A9 | 监听地址/端口范围变化（非 `127.0.0.1`、非 3000+1 重试） | 安全面变化 |
| A10 | 新增出网点（除 `llm` 与白名单 feeds） | 隐私与成本 |
| A11 | 任何"临时绕过"（注释掉红线检查、开关默认关闭红线行为、硬编码测试数据进生产路径） | 临时即永久 |
| A12 | 提交/推送/发布、改版本号、改 `package.json` 的 scripts 名 | 对外影响 |
| A13 | 合并 PR、改分支保护规则、改仓库可见性 | 主干与仓库的归属权，只有人能决定 |

提问格式：说清"要改什么 / 为什么必须改 / 不改的代价 / 影响哪些文件与验收项"，等人回答再动。

---

## 9. 合并前自检清单

1. `npm test` 全绿；`npm run check` 无输出。
2. **CI 在 `ubuntu-latest` 与 `windows-latest` 上都绿**（`.github/workflows/ci.yml`，跑 check → test → smoke）。本地绿但 CI 红，按红处理。
3. 改动在 `ticket-NN-<slug>`（票）或 `fix-<slug>`（bug，见 `Workflow.md` §0 / `/fix-bug`）分支上，PR 已按对应模板填好（票用 `.github/pull_request_template.md`，bug 用五段短版）；**合并由人点**，代理不自己合。
4. 新增文件在正确目录（ARCHITECTURE §3.2"不许放什么"）。
5. 没有新增反向依赖边、没有裸时间 API、没有裸 SQL、没有 `console.*`、没有注释。
6. 碰了红线？（§7）碰了契约？（§6 表 / A2）
7. 改动是否需要 §8 的同意？需要就先别合。
8. 票：验收项全勾、`Status: done`、`## Notes` 写了偏差与遗留。bug 修复：无票，commit body 写清症状/根因/修法/验证，PR body 写清风险与回归面——两处缺一不可（bug 不许补票，票也不许跳过 Notes）。
9. 配置 schema 没有偷偷长出"风格开关"之类的东西。
