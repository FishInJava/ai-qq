# 0003: 时钟与 tick 各只有唯一注入点

**Status:** accepted

**Context:** 这个产品里几乎所有行为都是"时间到了才发生"：20–40 分钟的 tick、6 小时硬触发、15 分钟冷却、09:00 生活事件、跨日照预算、暂停时长断层。如果时间判断散落在各模块（随手 `Date.now()`、`setInterval`），验收就只能等真实时间——T3（3 小时）、T6（跨日）、T9（暂停 5 小时）、T15（同日重复启动）会变成人工日测，等于没有自动化。

**Decision:**

1. `src/clock` 是全仓唯一时间源，接口固定为 §4.2 的六个方法；`now()` 可注入。
2. 生产实现 `systemClock`（系统时钟 + `setTimeout` 堆）；测试实现 `fakeClock`（可 `advance(ms)`，到期回调按时间排序执行）。
3. `src/**` 里除 `clock` 与 `schedule` 外，禁止出现 `Date.now()`、`new Date()`、`setTimeout`、`setInterval`、`Date.parse`。所有时长/跨日判断都问 `clock`。
4. 调度只有一个实现 `runTick(sessionId, trigger)`，`trigger ∈ {timer, hard, manual}`。定时器、硬触发、测试钩子调的都是这同一个函数，**不存在第二套模拟调度**。
5. 业务模块的定时行为只通过 `schedule` 暴露；任何模块不得自建 `setInterval`。
6. 时间格式统一 UTC ISO8601 入库；`life_events.event_date`、`daily_budget.date`、`world_feeds.date` 三个本地日期列由 `clock.localDay()` 产出，别处不换算。

**Consequences:**

- 好处：T 系列用例全部可在毫秒级断言"到点该发生什么"，最长 `sleep` 不超过 2s（PRD 4.3 tick <200ms 也在此被保护）。
- 代价：所有业务函数必须接受 `clock`（或从组合根注入），签名变长；禁止裸时间 API 需要 review 时 grep。
- 放弃：`node:timers/promises` 的隐式等待、任何基于真实时钟的"等 20 分钟"测试。
- 执行手段：`tools/check.js` 对 `src/**`（除 `clock`/`schedule`）grep 上述禁词，命中即报错。
