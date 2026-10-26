# 09: M4 主动消息：锚点、上下文硬闸、生成校验与预算闸门

**What to build:** 她能在用户没开口时主动说一句有具体内容的话：从今天还没用过的生活事件或还没用过的记忆里挑一件，明确声明锚点，服务端复核通过后才落库；预算满了就不说，任何校验失败都不扣预算、不写消息。

**Blocked by:** 08（M4 她的今天：生活事件、世界信息与幂等补齐）

**Status:** done

- [x] `proactive_log` 仓库补齐 `insert` / `listRecent`；`facts.markDone` 把用过的 fact 从 `pending` 转 `done`；`sessions.markProactive` 写 `last_proactive_at`，`sessions.bumpIgnored` 给预算竞争失败方 `consecutive_ignored + 1`
- [x] `proactive.buildAnchors(sessionId)`：今日未使用生活事件（ordinal 正序）+ `pending` facts（`valid_from` 倒序），截断 5 条；每条带 `type` / `id` / `text` / `keywords`；过期 fact 与已用事件不进候选；空集合返回 `[]`
- [x] `proactive.buildContext(sessionId, anchors)`：人设 + 指令 ≤400 token、最近摘要 ≤3 条 ≤600、今日事件 ≤2 条 ≤200、pending facts ≤5 条 ≤200、最近 3 轮原文 ≤600；总量硬闸 `min(config.llm.proactive_context_budget, floor(config.llm.context_budget / 3))`；超限按“最旧原文 → facts → 多余事件 → 最旧摘要”顺序丢，最后仍超就只留截断后的人设
- [x] `proactive.generate(sessionId, anchors)`：先查会话状态、预算与锚点，任何一项不通过都不调模型；通过后走 `chat_model` 流式生成，要求只返回 `{bubbles, anchor}`；1–2 条气泡，合计 >60 字截到第一句，仍超则重生成一次，再超丢弃 `too_long`
- [x] 生成结果过风格后置过滤：命中系统腔黑名单重生成一次，再犯丢弃 `style_blocked`；JSON 解析失败 `llm_bad_response`；模型报错 `llm_error`；所有失败写 `proactive_drop{reason}` 并返回 `{ ok: false, reason }`
- [x] `proactive.validate(resp, anchors)`：`anchor.id` 属于本次集合、`anchor.type` 与来源一致、正文包含 `fact.value` 或事件按标点切出的 ≥2 字片段之一；任一条不成立返回 `{ ok: false, reason: 'anchor_fail' }`，不扣预算
- [x] `proactive.gate(sessionId)`：全局当日 ≥ `config.budget.daily_global` 返回 `budget_global_full`；本角色 ≥ `config.budget.per_session` 返回 `budget_session_full`；否则返回 `{ ok: true, remaining }`
- [x] `proactive.commit(sessionId, msg, anchor)`：单个 `store.tx()` 内复检 `state === 'active'`、`last_user_msg_at` 未被用户抢话、预算仍有额度；写 `messages`（`is_proactive=1`、`anchor_type` / `anchor_id`、`bubble_index`、tokens、estimated）、`proactive_log`（内容 + 前 8 字 fingerprint）、标记事件 `used_by_msg_id` 或 fact `done`、`daily_budget +1`、`token_ledger` 记 `proactive`、写 `last_proactive_at`；事务后 `bus.emit('message')`，首次跨 70% 再发 `quota`
- [x] 预算在生成后被别的会话抢满时，`commit` 丢弃并给本会话 `consecutive_ignored + 1`，不写消息、不扣预算、不记账本；用户抢话只丢弃，不增加 `consecutive_ignored`
- [x] `llm.chatStream` 增加可选 `jsonMode`（默认 `false`，只多传 `response_format`），对话路径行为不变
- [x] 假 LLM 增加 `proactive-ok`（从提示词里的 `[event:ID]` / `[fact:ID]` 回读锚点并复述该行片段）、`proactive-no-anchor`、`proactive-long`、`proactive-system`、`proactive-bad-json`
- [x] S2：锚点集合含今日事件与 pending facts、截断 5 条、过期 / 已用不进池；小预算下先丢最旧原文再丢 facts，总量不超硬闸；合法生成通过校验；错 id / 错 type / 正文不含锚点片段都 `anchor_fail`；>60 字截断与重生成；预算满与生成后被抢满都不落消息不扣预算；事件锚点写 `used_by_msg_id`、事实锚点转 `done`；`proactive_log` 有 8 字 fingerprint；成功提交发 `message` 事件
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：M4 的第二块——她得先“有话说”，才轮到调度决定“什么时候说”。本票只交付 `proactive` 模块与仓库能力，不接定时器、不写 `scheduler_state`、不做意愿公式；调度票直接调用 `gate` / `buildAnchors` / `generate` / `validate` / `commit`。

改动面：`src/proactive/index.js`（新）、`src/store/repo/{proactive-log,facts,sessions}.js`、`src/store/index.js`、`src/llm/index.js`、`src/runtime/index.js`、`tools/fake-llm/server.js`、`test/s2/t09-proactive.test.js`、本票。

约定：
- 预算闸门放在 `proactive`，不另开 `budget` 模块；`quota` 继续只管 token 账本，`store.budget` 只管计数行。
- 主动消息用 `chat_model` + `stream: true`（spec D-5）；`jsonMode` 只是让端点返回 JSON 对象，不改变对话路径。
- 锚点是“模型显式声明 + 服务端复核”，不做事后正则猜；事件关键词按标点切分并剔除“今天 / 刚才 / 有点”这类泛词，避免“今天”两个字就蒙混过关。
- 60 字是整条主动消息的硬上限：先截到第一句，仍超才重生成；重生成只针对超长与系统腔，锚点校验失败直接丢，不给模型第二次猜的机会。
- `consecutive_ignored` 只在预算竞争失败时 +1；用户回复后的清零、冷启动沉默、冷却与硬触发都留给调度票，避免本票越界改对话路径。
- 主动消息与普通消息同表同渲染，`is_proactive=1` 只用于内部与抽屉，不给界面加“主动”标签。

验收命令：`npm test`、`npm run check`、`npm run smoke`；本票没有新 HTTP 路由，S1 观察点等调度票接上 `runTick` 后补。


### 实现结果

- `src/proactive/index.js`：`gate` / `buildAnchors` / `buildContext` / `generate` / `validate` / `commit` 全部落地；主动消息走 `chat_model` 流式 + `jsonMode`，1–2 条、整条 ≤60 字，超长先截第一句、仍超重生成一次，系统腔重生成一次，锚点失败不重试。
- 仓库能力：`proactiveLog.insert/listRecent`、`facts.markDone/findById`、`sessions.markProactive/bumpIgnored`、`tokenLedger.listForSession`；`store.budget` 继续只负责计数行。
- 上下文硬闸：`min(proactive_context_budget, floor(context_budget / 3))`；按“最旧原文 → facts → 多余事件 → 最旧摘要 → 只留截断人设”收缩，兜底路径不再产出超预算消息。
- 提交事务：复检 `active`、`last_user_msg_at`、预算与锚点仍可用；成功才写消息 / 留痕 / 标记锚点 / 预算 / token 账本 / `last_proactive_at`，事务后发 `message` 与首次 `quota`。预算竞争失败 `consecutive_ignored + 1`，用户抢话只丢弃。
- 假 LLM：`proactive-ok` / `proactive-no-anchor` / `proactive-long` / `proactive-system` / `proactive-bad-json`；`/__last` 增加 `json_mode`。
- S2：`test/s2/t09-proactive.test.js` 10 条，覆盖锚点池、上下文收缩、三类锚点失败、截断与重生成、预算闸门与提交复检、事件 / 事实锚点结算、真实客户端 `json_mode` 请求。

### 验证

- 本地：`npm run check` 退出 0；`npm test` 73/73；`npm run smoke` 退出 0（端口 33667）。
- 主C：`npm run check` 退出 0；`npm test` 73/73；`npm run smoke` 退出 0（端口 58191）。

### 偏差与遗留

- 本票没有新增 HTTP 路由；`POST /api/test/tick` 与 S1 T3/T4/T5/T6/T11/T15 观察点留到调度票。
- `consecutive_ignored` 的清零、冷启动沉默、冷却与硬触发同样留给调度票。
- 主动消息暂未接到任何定时器；`runtime.proactive` 已创建，等待调度票调用。
