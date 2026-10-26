# 07: M3 记忆：事实抽取、20 轮摘要与关键词检索

**What to build:** 一轮对话结束后，她能从这段对话里悄悄记住“以后还用得上”的事；每聊满 20 个用户轮次，旧对话被压成一条不超过 300 字的摘要。记忆可读、可删、可关键词翻旧账，全部是尽力而为——抽不出来、摘要失败都不影响已经发出的回复。

**Blocked by:** 06（M2 长对话：20 轮不断线、上下文裁剪与用量回归）

**Status:** done

- [x] `facts` / `summaries` 仓库补齐版本化与检索：同 `session_id + subject + key` 只留一条 `valid_to IS NULL`；同值刷新 `valid_from` 并回到 `pending`，不同值先关旧行再插新行；关键词检索命中过期事实但排除 `status = 'dropped'`，摘要按内容检索
- [x] `memory.extract(sessionId, msgIds)`：只读本轮涉及的消息，走 `utility_model` + 强制 JSON schema（`found` + `facts[{subject,key,value}]`），`subject` 仅限 `user/char/world`，单次最多 5 条；非法条目丢弃，整段失败只写 `memory_extract_failed` 日志并返回 `null`
- [x] `memory.summarize(sessionId)`：以上一条摘要的 `to_msg_id` 为起点，满 20 个用户轮次生成一条 ≤300 字摘要，`from_msg_id` / `to_msg_id` 覆盖本次包含的整段（含最后一条角色气泡）；不足 20 轮返回 `null`，失败只写 `memory_summarize_failed`
- [x] `memory.search(sessionId, query, limit)`：纯关键词 `LIKE`，同时查 facts 与 summaries，`limit` 夹在 1–20，默认 5；不引入向量化
- [x] `GET /api/sessions/:id/memory` 返回 `{ facts, summaries }`（facts 含 `valid_to`，摘要按时间正序）；`DELETE /api/memory/facts/:id` 删单条；未知会话 / 未知记忆返回 404
- [x] `chat.send` 在消息与账本落库、SSE 发出之后异步触发 `extract` + `summarize`，不阻塞回复、不影响 `done`；同一会话的抽取 / 摘要各自串行，避免并发写重
- [x] 记忆的两类工具调用都 `retry: false`——记忆是尽力而为，堆积比缺失更坏
- [x] S2：同一 `subject + key` 换值保留旧版本、检索能命中过期事实；20 轮后生成一条摘要且再聊不足 20 轮不重复生成；抽取抛错只返回 `null`
- [x] S1：真实进程聊一句后事实出现在记忆接口并可删除；连聊 20 轮后摘要出现在记忆接口；未知会话 404
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：补齐 M3 的完成定义——事实可抽、摘要可查、翻旧账命中。本票不做主动消息（M4），不做记忆抽屉页面（四个页签一起做），不改对话上下文的裁剪顺序。

改动面：`src/memory/index.js`（新）、`src/store/repo/{facts,summaries,messages}.js`、`src/store/index.js`、`src/store/handle.js`、`src/http/routes/memory.js`（新）、`src/http/index.js`、`src/runtime/index.js`、`src/chat/index.js`、`src/llm/index.js`、`tools/fake-llm/server.js`、`test/s1/t07-memory-api.test.js`、`test/s2/t07-memory.test.js`、本票。

约定：
- 抽取与摘要都在 `chat.send` 落库之后以 `void` 方式触发；回复先走完，记忆慢一点没关系。失败只记日志，不向 SSE 发错误。
- 事实版本化用“关旧行 + 插新行”，不做原地覆盖：旧值仍可被 `search` 翻到，当前上下文只取 `valid_to IS NULL AND status = 'pending'`。
- 摘要是“每满 20 个用户轮次一条”，不是滑动窗口；`to_msg_id` 落在该轮最后一条角色消息上，下一次从它之后继续。
- `utility_model` 走 `retry: false`；`chat_model` 的重试策略不变。

验收命令：`npm test`、`npm run check`、`npm run smoke`；另起进程聊一句，确认 `GET /api/sessions/:id/memory` 能读到抽出来的事实。

**落地**：

- `src/memory/index.js` 提供 `extract` / `summarize` / `list` / `removeFact` / `search`。抽取与摘要各自用 `Set` 做同会话串行锁；所有异常在模块内 `catch`，只写 `memory_extract_failed` / `memory_summarize_failed` 日志并返回 `null`。`llm.json` 的返回形状是 `{ value, usage }`，模块取 `value` 再做字段校验——这里最初漏了 `.value`，导致真实进程里“调了模型但一条事实都没落”，S2 的假 `llm` 当时直接返回裸对象，所以没暴露；现已修正并把假 `llm` 改成同样返回 `{ value }`，让 S2 与真实客户端形状一致。
- `src/store/repo/facts.js` 补 `findActive` / `insert` / `close` / `touch` / `listAll` / `search` / `remove`。版本化按 D-8：同 `subject + key` 同值只刷新 `valid_from` 并回到 `pending`；不同值先给旧行写 `valid_to`，再插一条新的 `pending`。`search` 用 `LIKE`，含过期行、排除 `dropped`。
- `src/store/repo/summaries.js` 补 `lastForSession` / `listAll` / `insert` / `search`；`messages.js` 补 `listByIds`（抽取只读本轮消息）与 `listAfter`（摘要从上次 `to_msg_id` 之后继续）。
- `src/chat/index.js` 在消息、账本与 `token_used` 落库之后触发 `void memory.extract(...)` 与 `void memory.summarize(...)`；`done` 不等待记忆，记忆失败也不会变成 SSE `error`。
- `src/llm/index.js` 的 `chatOnce` / `json` 增加 `retry` 选项，默认 `true`；记忆两处显式传 `false`。
- `src/http/routes/memory.js` 挂 `GET /api/sessions/:id/memory` 与 `DELETE /api/memory/facts/:id`；未知会话 / 未知记忆都是 404。`src/runtime/index.js` 装配 `memory` 并注入 `chat` 与 `http`。
- 顺手修掉 `store.close()` 里引用未定义 `handles` 的潜在崩溃：句柄改由 `src/store/handle.js` 的 `deleteHandle` 释放。此前只有常驻进程会走到 `close()`，新 S2 用例直接开关 store 才把它暴露出来。
- `tools/fake-llm/server.js` 增加 `memory-ok` / `extract-empty` / `extract-bad` 三个剧本，`/__last` 仍可看最近一次请求。

**验证**：本机与主C（`G:\0ALLInAI\0DSHtemp\Testproduct`，Node v24.11.1）均通过：`npm run check` 无输出；`npm test` 55/55 绿（本票 S1 2 条、S2 3 条）；`npm run smoke` 退出码 0（主C 本次 port 56269）。本机另起真实进程手工验证：导入并开始一张卡 → 发“我住在杭州。”→ SSE 依次 `user_ack` / `bubble` / `done` → 800ms 后 `GET /api/sessions/1/memory` 返回 `subject=user, key=city, value=杭州, status=pending, valid_to=null`；`GET /api/sessions/999999/memory` 返回 404 `session_not_found`。

**偏差**：

- 每条事实各自一个 `store.tx()`，而不是整批一个事务：单条失败只影响自己，且抽取并发锁已经保证同会话串行。
- 同值刷新时返回给调用方的 `saved` 行是旧行字段 + 新的 `valid_from` / `status`，没有重新查库；对外只用于日志与测试，不进入 API 响应。
- 摘要 `to_msg_id` 会向后吞掉该轮之后的连续角色气泡（包括多气泡回复），保证“这一段”完整；票里只要求覆盖区间，没规定气泡边界。
- 记忆没有新增页面入口：D-15 的“记忆”页签要和调度 / 她的今天 / 用量一起做，本票只交付接口。

**遗留**：

- 抽取是“每轮一次”的尽力而为：同一会话上一轮抽取未结束时，新一轮直接跳过（`extracting` 锁），不会排队补抽。
- `fact_extract.found=false` 占比统计与正则兜底（spec D-8 的 40% 触发条件）还没做，等有真实使用数据再补。
- `status = 'dropped'` 目前没有写入路径：删除走 `DELETE` 直接删行；等主动消息“用过即 done / 冲突即 dropped”时再补状态流转。
- `search` 只有模块面，没有 HTTP 路由；等“翻旧账”接进对话或主动消息时再决定是否暴露。
- 记忆抽屉、事实编辑与“这条记错了”的用户纠正都还没有，属于后续抽屉票。

