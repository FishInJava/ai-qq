# 11: M5 会话全态、续额、用量、配置与清空数据

**What to build:** 用户能在页面上把她从「醒着」切到「在忙」再切回来；额度用完时她安静下来，续一点之后又能开口，且下一句带一点好转的语气；用量抽屉能按日和按消息看到 token 花在哪；设置页能读回脱敏后的配置并保存；托盘能暂停所有会话、清空全部数据或优雅退出。整个过程里，额度与错误只出现在界面，不出现在她的嘴里。

**Blocked by:** 10（M4 调度：剪枝、意愿、硬触发、定时器宿主与启动补齐）

**Status:** done

- [x] `session.transition(sessionId, event, ctx)` 成为唯一状态迁移入口：`start` / `pause` / `resume` / `exhaust` / `refill` / `restart` / `llm_down` / `llm_up`；非法迁移不改库、写 warn；成功迁移写 `state_change` 事件并 `bus.emit('state')`
- [x] `session.getSession` / `session.view` / `session.canGenerate` / `session.pauseAll` / `session.refill` 落地；`active` 与 `paused` 可生成对话，`dormant` 与 `unstarted` 不可生成；`view` 与 `canGenerate` 会先把“已耗尽但仍 active/paused”的会话懒迁移到 `dormant`
- [x] `PATCH /api/sessions/:id`：`{ active?: bool, token_limit?: number }`；`active:false` 只允许 `active → paused`，`active:true` 只允许 `paused → active`；`token_limit` 为 1–10,000,000 整数；改小到已用以下立即转 `dormant`；未知会话 404，空请求 400，非法状态迁移 409
- [x] `paused → active` 时若暂停/沉默 ≥2h，写 `pause_gap_hours`，下一次对话生成注入时间断层；生成成功后清掉，只影响下一句
- [x] `POST /api/sessions/:id/refill`：`{ amount }` 正整数，只提高 `token_limit`，不复位 `token_used`；写一条 `token_ledger(kind='refill')`；`dormant` 且新上限足够时转回 `active`；下一句生成带“好转”提示；非法数量 400，未知会话 404
- [x] `quota.raiseLimit(sessionId, n)` 与 `quota.usage({ from, to })` 落地；`quota.record` 继续写 `sessions.token_used` 与 `token_ledger` 同事务，返回 `warnFirst` / `exhausted`；`evaluate` 增加 `status: 'ok'|'warn70'|'exhausted'`
- [x] 对话或主动消息记账后若 `token_used >= token_limit`，由调用方走 `session.transition('exhaust')` 转 `dormant`；主动消息下一次 tick 直接 `state_not_active`
- [x] `GET /api/usage?from=&to=`：日期 `YYYY-MM-DD`（本地日），缺省为今天；返回按日聚合（`chat` / `proactive` / `refill` 分开）、按消息明细（来自 `token_ledger`）与每个会话的当前用量/上限/比例/告警/耗尽；日期非法或 `from > to` 返回 400
- [x] `GET /api/config` 返回完整配置，`llm.api_key` 只回 `****` + 后四位；`PUT /api/config` 接受部分字段，`api_key` 为空字符串表示不改；保存后立即写 `config.json` 并更新内存配置；`server.host` 非 `127.0.0.1` 或字段类型非法返回 400；端口与 `runtime.test_hooks` 变更返回 `restart_required: true`
- [x] `POST /api/admin/pause-all`：所有 `active` 会话转 `paused`，返回暂停数量；`POST /api/admin/purge`：必须 `{ confirm: "DELETE" }`，先 `VACUUM INTO` 备份数据库，再清空全部业务表与卡片/头像文件；`POST /api/admin/quit`：响应发出后优雅停止进程
- [x] `/api/admin/*` 仅接受本机直连：`Host` 校验之外，有 `Origin` 时必须同源，否则 403；页面不暴露入口
- [x] T7：会话压到 `dormant` 后穷举卡片、历史、她的今天、记忆、tick、用量、配置与发消息接口，所有用户可见字符串中“额度 / 配额 / 余额 / error”出现次数为 0
- [x] T8：沿用现有 70% 用例；聊天头部增加只读用量角标/进度条，由 `done.quota`、`quota` SSE 与 `GET /api/usage` 驱动，文案只写“已用 N%”，不出现“余额 / 充值”
- [x] T9：假时钟把 `paused` 推进 5h 再回 `active`，断言生成提示含时间断层、首条带时间指涉、正文无 `pause_gap_hours` 之类元信息
- [x] S1：会话 PATCH / 续额 / 用量 / 配置脱敏与保存 / 暂停全部 / 清空确认 / admin 同源校验；S2：状态机、暂停断层、耗尽与续额、用量跨日聚合
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：把 M4 的“她会说话”收进用户可控制的边界。本票只做会话全态、额度账本、配置与管理员接口，不做四页签抽屉的完整视觉（下一票），也不新增第三方依赖或迁移。

约定：

- **不新增迁移**：Rule A3 要求改数据模型先征得人同意。`paused_at` 不入库，暂停起点用进程内 `Map` 记录；进程在暂停期间重启时，`resume` 以 `last_user_msg_at`（没有则 `created_at`）兜底计算沉默时长。`pause_gap_hours` 仍是既有列，语义不变。
- **状态机唯一入口**：`quota.record` 只记账并返回 `exhausted`，不直接改 `sessions.state`；`chat` 与 `schedule` 在记账后调用 `session.transition('exhaust')`。`session.view` / `canGenerate` 会懒迁移历史遗留的“已耗尽但状态未变”会话。
- **续额不是复位**：`token_used` 单调不减，`token_limit` 只增不减由调用方决定；`PATCH token_limit` 允许改小，改小到已用以下立即 `dormant`。续额写 `refill` 流水，金额是本次提高的上限，不计入用量合计。
- **好转提示不落库**：`recovered` 由“最近一条 refill 流水晚于最近一条 char 消息”推导，不新增列；下一句生成后自然消失。
- **清空可回滚**：`purge` 先 `VACUUM INTO data/companion.backup-<ts>.db`，成功后才删业务表与 `cards/`、`avatars/`；备份失败则整体失败，不动数据。
- **T7 的扫描范围**：只扫用户可见字符串值（消息正文、状态词、错误文案、配置展示值），不把 JSON 字段名（如 `error` 键、`token_used`）算作系统腔；协议字段名不是角色台词。
- **T8 的角标**：`GET /api/cards` 的既有字段不动；头部用量从 `GET /api/usage` 的 `sessions` 与 SSE `quota` / `done.quota` 取，避免改 §6.1 的响应形状。
- **管理员路由**：`/api/admin/*` 只给托盘辅助进程，页面不加入口；`purge` 后广播 `import` 让页面重新拉卡片。

### 验证

- 本地：`npm run check` 退出 0；`npm test` 94/94 全绿；`npm run smoke` 退出 0（端口 44231）。
- 主C：`npm run check` 退出 0；`npm test` 94/94 全绿；`npm run smoke` 退出 0（端口 61524）。

### 偏差与遗留

- `pauseAll` 对“已耗尽但仍 active”的会话先懒迁移到 `dormant`，只把真正醒着的会话转 `paused`；暂停数量只统计后者。
- `transition('restart')` 只沉默传入的那个会话；`llm_down` / `llm_up` 是自环，只留日志与状态事件，不改库。
- 未新增迁移；暂停起点仍用进程内 Map，重启后按 `last_user_msg_at` / `created_at` 兜底。
- 四页签抽屉的完整视觉仍留到下一票；本票只加了聊天头部只读用量角标。
