# 18: 冷启动沉默只作用于从未对话过的新会话

**What to build:** 重启进程后，**已经聊过的角色不再被重新沉默**，调度器按正常节奏（20–40 分钟 tick、15 分钟冷却、意愿 0.60、每日预算、6h 硬触发）评估她要不要主动开口；只有**从未对话过**（`last_user_msg_at` 与 `last_proactive_at` 都为空）的新会话，重启后才保持沉默、等用户说第一句。不能因此刷屏。

**Blocked by:** 17

**Status:** done

## 背景 / 为什么改

现状（spec §状态机表 + R1）：`schedule.start()` 在每次启动且 `cold_start_proactive !== true` 时对**所有** active 会话置 `cold_start_silenced=1`。于是用户只要重启进程（关机重开、`npm run dev` 自动重启、崩溃被守护拉起），哪怕之前天天聊，也必须再先说一句她才会主动。实测用户两个老会话就是这样被永远挡在 `cold_start`。

**仍要防刷屏**（沿用既有闸门，本次不放宽任何一个）：15 分钟冷却、20–40 分钟 tick 抖动、意愿阈值 0.60、每日全局 5 / 单角色 2 条预算、6 小时硬触发、8:00–23:00 时段、连续忽略 ×1.5 退避。

## 复述

- 目标：重启后老会话能到点主动；新会话仍等用户先开口；主动频率不因本票上升。
- 改动面（归属模块）：
  - `src/store/repo/sessions.js`：`silenceColdStart` 的 SQL 加"从未对话"条件；`silenceColdStartFor` 同样只在从未对话时置沉默（保持自环语义一致）。**SQL 只在 store，符合硬规则 2。**
  - `.scratch/.../spec.md` 状态机表第 106 行 + R1：改述为"仅从未对话的会话重启后沉默"。
  - `docs/ARCHITECTURE.md` §状态机那句"重启是自环：置 cold_start_silenced=1"同步措辞。
  - `test/s2/t10-schedule.test.js`：原冷启动用例拆成"新会话仍沉默 / 已聊会话重启不再沉默"两条用户视角断言；不新增依赖、不改数据模型、不改 HTTP 契约。
- 同意项：无（不触 Rule §8；不改表结构，只改一条 UPDATE 的 WHERE）。
- 验收命令：`node --test test/s2/t10-schedule.test.js`、`npm test`、`npm run check`、`npm run smoke`。

## 验收项

- [x] 从未对话（两个 last_* 都空）的 active 会话：重启后 `cold_start_silenced=1`，tick 以 `cold_start` 跳过；用户发一句话后转 0 并能 `send`。
- [x] **已有用户消息**（`last_user_msg_at` 非空）的 active 会话：重启后 `cold_start_silenced` 不被置 1，满足其它条件时 tick 可 `send`，不需要用户再先说话。
- [x] **收到过主动消息**（仅 `last_proactive_at` 非空）的会话同样不被重新沉默。
- [x] 防刷屏闸门数值本票不动；已聊会话在 15 分钟冷却内仍 `too_soon`、预算满仍 `budget_*`、意愿不足仍 `low_willingness`（已聊用例越过冷却才 send；另一条用例断言刚说话在 15 分钟内仍 too_soon）。
- [x] `npm test` 全绿（110/110）、`npm run check` 无输出、`npm run smoke` 退出码 0。

## Notes

**落地**：
- `src/store/repo/sessions.js`：
  - `silenceColdStart` 与 `silenceColdStartFor` 的 SQL 加条件 `last_user_msg_at IS NULL AND last_proactive_at IS NULL`——只沉默从未对话的会话。
  - 新增 `reconcileColdStart()`：active 且从未对话 → 置 1；active 且已聊过 → 置 0。第二条用来清掉**旧版本无差别置 1 残留在老会话上的标记**（用户当前两个会话正是这个状态，否则改完代码重启仍被挡）。
- `src/store/index.js`：导出 `reconcileColdStart`。
- `src/schedule/index.js` `start()`：`cold_start_proactive !== true` 时由 `silenceColdStart()` 改为 `reconcileColdStart()`。语义不变的部分：配置打开 `cold_start_proactive=true` 仍完全不沉默。
- 文档同步：`.scratch/.../spec.md`（状态机表第 106 行 + R1）、`docs/ARCHITECTURE.md` §4.4 重启自环那句、`GLOSSARY.md`「冷启动沉默」词条。
- 测试 `test/s2/t10-schedule.test.js`：原 1 条冷启动用例改为 3 条用户视角——①从未对话仍沉默、发言后恢复并 send；②已聊会话带旧残留标记，启动校正清零后到点 send；③仅收到过主动消息也不沉默（停在 no_anchor 而非 cold_start），且刚说话在冷却内仍 `too_soon`。

**防刷屏**：本票不放宽任何频率闸门——`cooldown_min=15`、`tick_min/max=20/40`、`willingness_threshold=0.60`、每日全局 5 / 单角色 2、硬触发 6h、时段 8–23、连续忽略 ×1.5 全部原样。老会话重启后第一次 tick 仍要同时过这些关；刚说过话必 `too_soon`，测试已锁。

**验证**：先红（新增 2 条用例在旧实现下失败：老会话被置 1）后绿；`npm test` 110/110（首轮 s1 有 3 条进程启动 3.5s 超时，属票 15 Notes 记录的既有 flaky，单跑全绿、全量重跑 110/110）；`npm run check` 无输出；`npm run smoke` 退出码 0。

**偏差**：`docs/ai-companion-spec.md` 第 49 行 R1 仍是上游旧措辞（"每次开机/重启后她不主动说话"）。该文件是上游封板决策（Rule §8-A7 只读），未改；行为以本票更新后的 `.scratch spec` 与 ARCHITECTURE 为准。需要上游同步时请人处理。

**遗留**：用户本机当前运行的进程（旧代码）仍持有旧标记；本票代码上线并重启后 `reconcileColdStart` 会自动清掉两个老会话的残留，无需手工改库。
