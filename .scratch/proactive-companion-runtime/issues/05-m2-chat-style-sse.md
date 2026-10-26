# 05: M2 对话流：发消息、风格后置过滤、历史与全局事件

**What to build:** 用户点开一张已开始的卡，先看到历史消息，再输入一句话；页面按 `user_ack → bubble* → done` 的顺序逐条出现她的短句，而不是一整段书面语。系统腔会被重生成或截断，消息、token 用量与最近发言时间都落库；角色库摘要和全局事件不用刷新就更新。

**Blocked by:** 04（M2 LLM 客户端与本地假供应商）

**Status:** done

- [x] `GET /api/cards` 增加只读 `session_id`，前端据此拉历史（人已确认，只加字段不改已有字段）
- [x] `GET /api/sessions/:id/messages?before=&limit=` 倒序取、正序返；未知会话 404，`limit` 夹在 1–100
- [x] `POST /api/sessions/:id/messages` 接收 `{ text }`，以 `text/event-stream` 返回 `user_ack{message_id}` → `bubble{message_id,bubble_index,text,incomplete}`* → `done{tokens,estimated,quota}`；生成失败发 `error{code,message}` 后关闭
- [x] `chat.send` 先落用户消息，再组装上下文、流式生成、后置过滤、逐气泡落库；每条 `char` 消息带 `bubble_index` / `style_flags` / `tokens` / `estimated`，`sessions.last_user_msg_at` 与 `token_used` 同步更新，`token_ledger` 记一条 `chat`
- [x] `style.systemPrompt` 内嵌四条判据（碎片化 / 用人话补救 / 给台阶 / 允许喊累），卡片文本统一包进 `<card_data field="…">` 数据块，不拼进指令位；风格没有开关
- [x] `style.postProcess` 把 >120 字且无分行的整段按句切成 1–3 条气泡；命中系统腔/客服腔黑名单（含 `额度`、`配額`、`余额`、`作为 AI`、`error`、`请澄清您的需求`）时由 `chat` 重生成 1 次，再犯则截断该句；`style_flags` 记录 `split` / `regenerated` / `truncated`
- [x] T1：S2 的 `fake-long` 返回整段书面语 → 断言拆成 1–3 条气泡且 `style_flags` 有 `split`
- [x] T2：S2 的 `fake-restate` 首次返回“请澄清您的需求”、重生成后返回人话 → 断言最终消息不含该短语，且 `style_flags` 有 `regenerated`
- [x] `GET /api/events` 全局 SSE：新消息发 `message`，跨 70% 阈值发一次 `quota`；页面据此刷新角色库摘要，不需要手动刷新
- [x] 页面：选中已开始会话时加载历史；发送后先出现自己的消息，再逐条出现她的气泡；失败只给页面提示，不把错误码写进对话
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：把“用户发一句话 → 她按自己的风格回几条 → 落库并广播”这一条链打通。主动消息、记忆抽取、摘要生成不在本票。

改动面：`src/chat/index.js`、`src/style/index.js`、`src/quota/index.js`、`src/cards/parse.js`（补人设字段）、`src/store/repo/{messages,facts,summaries,sessions}.js`、`src/store/index.js`、`src/http/{router,respond,routes/messages,routes/events,sse}.js`、`src/runtime/index.js`、`web/*`、`test/s1/t05-chat.test.js`、`test/s2/t05-style.test.js`、`tools/fake-llm/server.js`、本票。

同意项：无新增依赖；`GET /api/sessions/:id/messages`、`POST /api/sessions/:id/messages`、`GET /api/events` 均已在 ARCHITECTURE §6.2 的契约里。`GET /api/cards` 增加 `session_id` 已问人并得到同意（只加字段，不改已有字段）。

实现要点：
- SSE 帧格式照 ARCHITECTURE §6.4；`bubble` 的 `message_id` 是该气泡落库后的 id，`bubble_index` 从 0 递增；`done.tokens` 是本轮生成的总 token，`done.quota` 为 `{used,limit,ratio,warn}`。
- `usage` 存在就用 `total_tokens`；缺失时按“提示词 + 回复”的字符数估算，`estimated = 1`，不伪造 `usage`。
- 上下文：人设（`description` / `personality` / `scenario` / `mes_example`）+ 最近 ≤3 条摘要 + 最近原文 + `pending` facts ≤5；按 `config.llm.context_budget` 裁剪，顺序“先丢最旧原文 → 再丢超 5 条 facts → 摘要永不丢”。本票没有摘要/facts 时自然只剩人设与原文。
- `paused` 允许对话（`canGenerate` 为真），`unstarted` / `dormant` 拒绝；`sessions.character_id` 为 NULL 的孤儿会话没有卡面，按 404 处理。
- 假供应商新增 `fake-restate`（首次客服腔、第二次人话）与更长的 `fake-long`（>120 字且无分行）；`/__stats` 继续按模式计数。
- 全局 SSE 连接不引入定时器；断线由浏览器自动重连，测试只断言事件顺序与内容。

已确认：
1. 前置错误（会话不存在 / 未开始 / 不方便 / 空文本）直接 HTTP 4xx JSON，不打开 SSE。
2. 重生成后仍然全是黑名单句：发 `error{code:'style_blocked'}`，不落库，不编造兜底句；用户消息保留。

验收命令：`npm test`、`npm run check`、`npm run smoke`；另起进程手发一条消息，确认页面逐条出现气泡且刷新后历史仍在。

**落地**：

- `src/chat/index.js` 提供 `history` / `buildContext` / `send`。`send` 先校验会话与文本，再在事务里落用户消息并更新 `last_user_msg_at`，随后组装上下文、调用 `llm.chatStream`、跑 `style.postProcess`，最后在另一个事务里逐气泡写 `messages`、记 `token_ledger` 并更新 `sessions.token_used`。`paused` 允许生成，`unstarted` / `dormant` / 额度耗尽 / 孤儿会话都在第一个 `yield` 前抛 `AppError`。
- `src/style/index.js` 负责人格提示词与后置过滤。卡片字段统一包成 `<card_data field="…">`，卡片自带的 `system_prompt` / `post_history_instructions` 也只作为资料块，不进入指令位。黑名单覆盖 `额度`、`配額`、`配额`、`余额`、`作为 AI`、`error`、`请澄清您的需求` 等；>120 字且无换行的整段按句切分并合并到最多 3 条。
- `src/quota/index.js` 新增 `evaluate` 与 `record`。`record` 不加嵌套事务，调用方负责包 `store.tx()`；首次跨过 70% 时返回 `warnFirst`，`chat` 只在这时广播一次 `quota`。
- `src/http/routes/messages.js` 在第一次 `iterator.next()` 里完成所有前置校验，成功后才切 SSE，因此前置失败仍是普通 4xx JSON；生成中途失败发 `error` 帧后关闭。`src/http/routes/events.js` 把 bus 的 `message/state/quota/tick/import` 转成全局 SSE，不引入心跳定时器。
- `web/app.js` 选中已开始会话时按 `session_id` 拉历史；发送后先追加自己的消息，再按 `bubble` 事件逐条追加她的气泡。全局 `EventSource` 只做增量去重与角色库刷新，不把错误码写进对话。`web/index.html` / `web/styles.css` 补上消息列表、气泡和输入框状态。
- `src/cards/parse.js` 补 `personality` / `scenario` / `first_mes` / `mes_example` / `system_prompt` / `post_history_instructions`；`src/library/index.js` 的 `GET /api/cards` 增加只读 `session_id`。
- 假供应商新增 `fake-restate`、`fake-mixed`，并把 `fake-long` 加长到 122 字；`/__stats` 仍按模式计数。

**验证**：本机与主C（`G:\0ALLInAI\0DSHtemp\Testproduct`，Node v24.11.1）均通过：`npm run check` 无输出；`npm test` 46/46 绿（本票 S1 8 条、S2 5 条，覆盖正常发送、T1 拆分、T2 重生成、全黑名单 `style_blocked`、部分黑名单截断、前置 4xx、paused 与分页、全局 SSE 只发一次 quota）；`npm run smoke` 退出码 0（主C 本次 port 54915）。本机另用 headless Chrome + CDP 手工走了一遍页面：导入并开始一张卡 → 点开 → 输入“在吗？”→ 先出现用户消息、再出现“嗯，我在。”→ 刷新后历史仍在，控制台无异常。

**偏差**：

- `style_flags` 除票里要求的 `split` / `regenerated` / `truncated` 外，还记了 `blacklist`（最终回复是否仍有被拦句子），方便排查；不改变对外契约。
- 为覆盖“重生成后仍被拦”的分支，假供应商多了一个 `fake-mixed` 剧本（一句人话 + 一句系统腔），票里只写了 `fake-long` / `fake-restate`。
- `usage` 存在但 `total_tokens` 缺失或非正数时按字符数估算并置 `estimated = true`，避免把 `undefined` 记进账本。
- 前置错误用 4xx JSON，生成中途才用 SSE `error` 帧；这与已确认项一致，但两种失败形态并存，前端需要分别处理。

**遗留**：

- `chat.send` 会等整段生成完再逐条发 `bubble`，不是 token 级流式；用户能看到 `user_ack` 后短暂等待。要逐字上屏需要改 `style` 的流式切分，本票不做。
- `chatStream` 仍没有取消句柄，用户连发时不能中断上一条；等主动消息或“发新消息打断旧回复”时再补 `AbortSignal`。
- 本票只读 `facts` / `summaries`，没有抽取与摘要生成；空表时上下文自然只剩人设与原文。
- 页面没有“正在输入”占位，生成期间只把发送按钮置为“发送中…”；后续可补一个静态气泡占位。

