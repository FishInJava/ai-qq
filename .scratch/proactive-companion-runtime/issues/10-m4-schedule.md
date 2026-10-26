# 10: M4 调度：剪枝、意愿、硬触发、定时器宿主与启动补齐

**What to build:** 她自己决定“现在要不要开口”：每次 tick 按固定顺序剪枝，算一个规则式意愿分；到点由抖动定时器调用同一个 `runTick`，6 小时硬触发只跳过冷却；预算、锚点、抢话与风格失败都不落消息、不扣预算。生产进程不依赖任何 SSE 连接，启动时幂等补齐当日 feeds 与生活事件。

**Blocked by:** 09（M4 主动消息：锚点、上下文硬闸、生成校验与预算闸门）

**Status:** done

- [x] `scheduler_state` 仓库补齐 `insert` / `listRecent` / `countSince`；`sessions.markUserMessage` 同时清零 `consecutive_ignored`、`cold_start_silenced` 与 `hard_dedup_until`；`sessions.setHardDedup` / `silenceColdStart` 落地
- [x] `schedule.runTick(sessionId, trigger)`：`trigger ∈ {timer,hard,manual}`；按“状态 → 冷启动 → 全局预算 → 角色预算 → 静默期 → 冷却 → 锚点 → 意愿”顺序剪枝，命中即停并写一行 `scheduler_state`；`hard` 只跳过冷却
- [x] 意愿公式照 spec D-3：`0.30*silence + 0.25*has_fact + 0.20*budget_room + 0.15*event_room + 0.10*time_fit - 0.20*ignored`，`clamp01`；15 分钟→0、6 小时→1 线性；08–23 为 1，23 点后线性降到 0
- [x] 冷却默认 15 分钟；`consecutive_ignored ≥ 3` 时冷却与抖动间隔 ×`ignored_multiplier`（默认 1.5）
- [x] 通过后调用 `proactive.buildAnchors` → `generate` → `commit`；生成 / 提交失败把 `proactive` 的 `reason` 写进 tick 留痕，不重复扣预算；预算竞争失败由 `proactive.commit` 给本会话 `consecutive_ignored + 1`
- [x] 3 小时不回时给一次台阶：生成上下文追加“给个台阶”提示；发送成功后 `hard_dedup_until` 收到次日零点，后续 tick 记 `silenced`，用户发言后清掉
- [x] 高 tick 日（本本地日已有 8 次 tick）且尚未发过台阶时，追加“可以喊累”提示；发送后同样静默到次日或用户发言
- [x] 调度器宿主：每会话 20–40 分钟抖动 timer，6 小时硬触发 timer；单会话上一轮未结束时跳过本次（`busy`，不排队）；`state` 事件与用户 `message` 事件重新挂 timer；`stop()` 清掉所有 timer 与订阅
- [x] 每日 08:30 只补 feeds、09:00 只补生活事件；`living` 拆出 `ensureFeeds` / `ensureEvents`，`ensureAll` 保持“先 feeds 再事件”的启动补齐语义
- [x] 启动时按 `runtime.cold_start_proactive`（默认 false）给已有 active 会话置 `cold_start_silenced`；不阻塞 HTTP，后台执行 `living.ensureAll()`
- [x] `GET /api/sessions/:id/debug/ticks?limit=20` 返回最近 tick 留痕，limit 夹在 1–20；`POST /api/test/tick {session_id,trigger}` 只在 `runtime.test_hooks === true` 时挂载，未知会话 404、非法 trigger 400
- [x] S2：剪枝顺序、意愿公式、硬触发只跳冷却、台阶后 `silenced` 与用户发言恢复、喊累后静默、全局 3 / 角色 2 与次日重置、冷启动沉默、tick 留痕 limit
- [x] S1：无 SSE 连接时手工 tick 仍落库主动消息且 `anchor_type` 非 none、留痕可读、预算满后不再发；测试钩子默认关闭返回 404；未知会话 / 非法 trigger 入参校验
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：把 09 的“她有没有话说”接上“什么时候说”。本票只做调度与宿主，不新增模型调用形状；所有生成、校验、预算与落库仍由 `proactive` 负责。

改动面：`src/schedule/index.js`（新）、`src/store/repo/scheduler-state.js`（新）、`src/store/repo/sessions.js`、`src/store/index.js`、`src/living/index.js`、`src/proactive/index.js`（`guidance` 追加）、`src/http/routes/schedule.js`（新）、`src/http/index.js`、`src/runtime/index.js`、`test/s1/t10-schedule-api.test.js`、`test/s2/t10-schedule.test.js`、本票。

约定：
- 剪枝顺序逐条照抄 spec D-3；新增的 `cold_start`、`silenced`、`busy` 只用于本票新增的两类静默与“上一轮未结束”，不改原有 6 条顺序。
- 意愿公式不调模型；`hard` 只跳过第 4 条冷却，绕不过预算、锚点与意愿。
- 台阶 / 喊累不是新消息类型，只是生成时追加一段系统提示；发送成功后用 `hard_dedup_until` 收住，用户发言由 `markUserMessage` 清掉。两者都静默到“次日零点或用户发言”先到者。
- 定时器宿主只负责到点调用 `runTick`；测试全部用 `manual` 触发同一个函数，不等待真实分钟。`hardAttempts` 防止硬触发在 `last_user_msg_at` 很旧时 0ms 自循环。
- 启动补齐不阻塞 HTTP：`schedule.start()` 后 `void catchUp()`；feeds 与生活事件失败只记日志，今天的她仍可只靠人设和历史事实开口。
- `scheduler_state` 只增不删；抽屉页签后续直接读 `GET /api/sessions/:id/debug/ticks`，不新增第二套调度状态。

### 验证

- 本地：`npm run check` 退出 0；`npm test` 84/84；`npm run smoke` 退出 0（端口 32819）。
- 主C：`npm run check` 退出 0；`npm test` 84/84；`npm run smoke` 退出 0（端口 59474）。

### 偏差与遗留

- `POST /api/test/clock/advance` 尚未实现；本票的时间类用例走 S2 假时钟直接调 `runTick`，S1 只验证真实进程里的手工 tick。时钟推进钩子留给后续测试钩子票，避免在本票引入第二套定时堆。
- T11 用“无 SSE 连接 + 手工 tick + 重连读历史”覆盖常驻独立性；没有在 S1 里真实推进 20 分钟，也没有跨重启断言。
- T15 的启动补齐幂等由 `living.ensureAll` 的既有 S2 用例与 S1 的“连续两次 today 不重复”覆盖；本票没有重复跑启动补齐。
- 台阶 / 喊累的“次日零点”是产品取舍：若用户一直不发言，次日预算重置后她仍可能再开口；若需要“永久收住直到用户发言”，把 `hard_dedup_until` 改成远未来即可，不改表结构。
