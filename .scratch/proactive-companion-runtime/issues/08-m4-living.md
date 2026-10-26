# 08: M4 她的今天：生活事件、世界信息与幂等补齐

**What to build:** 打开“她的今天”时，她当天有 2–3 条自己的生活小事，素材来自当天抓到的天气、节日与一条头条；同一天反复打开或重启进程都不会重复生成，抓取或模型失败只影响那一条，不影响页面。

**Blocked by:** 07（M3 记忆：事实抽取、20 轮摘要与关键词检索）

**Status:** done

- [x] `life_events` / `world_feeds` 仓库补齐：按本地日取事件（ordinal 正序）、取未使用事件、计数、插入、标记 `used_by_msg_id`；feeds 按日按类取、`INSERT OR IGNORE` 幂等写入、清理 90 天前数据；`sessions.listAll` 供启动补齐遍历
- [x] `living.ensureToday(sessionId)`：当日已有 ≥1 条就原样返回；否则用角色卡人设 + 当日 feeds 走 `utility_model` + 强制 JSON schema 生成 2–3 条一句话事件，逐条 `ordinal` 落库；模型失败只写 `living_events_failed`，返回已有行
- [x] 生成后做一次人设一致性自检：冲突的事件重写一次；改写后仍冲突的条目直接丢弃，不硬塞；当日 0 条也允许，交给主动消息只锚定历史事实
- [x] `feeds.ensureDay(day)`：天气（`living.city`，为空时按系统时区映射城市；判不出就跳过）、节日（本地公历表）、一条头条（白名单 RSS 第一条标题 + 首句）；单类 8s 上限、失败互不拖累、每类每天只抓一次
- [x] `living.ensureAll()`：先补当日 feeds，再给所有已开始会话补当日事件；`unstarted` 跳过；重复调用不重复生成，不补历史
- [x] `GET /api/sessions/:id/today` 返回 `{ date, events, feeds }`；未知会话 404 `session_not_found`
- [x] S2：事件生成与幂等、冲突重写与丢弃、模型失败不抛、`ensureAll` 跳过 unstarted 且不重复、feeds 三类各一条且同日不重抓、单类失败不拖垮其他类
- [x] S1：真实进程打开“她的今天”拿到 2 条事件，再次请求 id 不变；未知会话 404
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：M4 的第一块——她得先有“今天”，主动消息才有东西可锚。本票只做生活事件与世界信息，不做调度、不做主动消息、不扣预算。

改动面：`src/living/index.js`（新）、`src/living/feeds.js`（新）、`src/store/repo/{life-events,world-feeds,sessions}.js`、`src/store/index.js`、`src/http/routes/living.js`（新）、`src/http/index.js`、`src/runtime/index.js`、`tools/fake-llm/server.js`、`test/s1/t08-living-api.test.js`、`test/s2/t08-living.test.js`、本票。

约定：
- 生活事件是“她的今天”，不是“用户和她的今天”：不写聊天、不写用户、不评论新闻。
- feeds 每天每类最多一条，靠 `UNIQUE(date, kind)` + 已存在就跳过保证幂等；不做历史补抓。
- 天气只认 `living.city` 或时区映射；城市判不出来就跳过天气，不猜。节日只算公历，农历节日不硬编。
- 所有网络与模型失败都是静默降级：只记日志，页面照常返回已有内容。

验收命令：`npm test`、`npm run check`、`npm run smoke`；另起进程打开 `GET /api/sessions/:id/today`，确认同一天重复请求事件 id 不变。

**落地**：

- `src/living/index.js` 提供 `ensureToday` / `ensureAll` / `today`。事件生成用 `utility_model` + 强制 JSON schema（`events` 2–3 条、每条字符串），逐条 `ordinal` 1..n 落库；同一会话用 `Set` 串行锁，重复调用直接读库。生成后再调一次一致性检查（`conflicts` 为冲突下标），冲突条目用一次重写替换，替换不上的直接丢弃；两次检查都失败或模型报错只写 `living_events_failed`，页面拿到已有事件或空数组。
- `src/living/feeds.js` 提供 `createFeeds({ store, clock, config, log, fetchImpl })`：天气走 Open-Meteo（`living.city` 为空时按系统时区映射城市，常见城市有静态坐标，其他城市只做一次地理编码），节日走本地公历表，头条走两条白名单 RSS（只取第一条 `<item>` 的标题 + 描述首句）。每类 8s 上限、`Promise.allSettled` 互不拖累，写入靠 `INSERT OR IGNORE` + `UNIQUE(date, kind)` 保证一天一类一条。
- `src/store/repo/life-events.js`、`world-feeds.js` 是新仓库；`sessions.js` 补 `listAll`；`src/store/index.js` 统一挂到 `store.lifeEvents` / `store.worldFeeds`。
- `src/http/routes/living.js` 挂 `GET /api/sessions/:id/today`，返回 `{ date, events, feeds }`；未知会话 404。`src/runtime/index.js` 装配 `feeds` / `living` 并注入 HTTP。
- `tools/fake-llm/server.js` 增加 `living-ok` / `living-conflict` 两个剧本；因为生成与一致性检查共用 `utility_model`，假服务按系统提示里的“一致性”字样和调用次数分流。

**验证**：本机与主C（`G:\0ALLInAI\0DSHtemp\Testproduct`，Node v24.11.1）均通过：`npm run check` 无输出；`npm test` 63/63 绿（本票 S1 2 条、S2 6 条）；`npm run smoke` 退出码 0（主C 本次 port 56729）。S1 用真实进程导入并开始一张卡后请求 `GET /api/sessions/:id/today`，拿到 2 条事件（ordinal 1、2，`used_by_msg_id` 为空），再次请求事件 id 不变；未知会话返回 404 `session_not_found`。

**偏差**：

- `GET /api/sessions/:id/today` 会顺手补齐当日事件（幂等），不是纯读；这样页面第一次打开就能看到内容，不需要额外的写入口。每日 08:30 抓 feeds、09:00 生成事件的定时触发留给调度票，本票只交付可幂等调用的 `ensureDay` / `ensureAll`。
- 本票没有在 runtime 启动时调用 `ensureAll`：那会让每个测试进程都发起真实网络请求，也会提前消耗 S2 剧本里按调用次数编排的 `utility` 响应。调度票接上启动补齐与每日触发。
- 一致性检查是整批一次调用（返回冲突下标），不是逐条检查；重写只替换冲突位，替换数量不够时宁可丢掉剩余冲突条目，也不把原句塞回去。
- 天气城市除静态表外还会走一次 Open-Meteo 地理编码；票里只写“城市取自系统时区映射”，多这一步是为了让 `living.city` 填小城市也能用。
- 节日只覆盖公历固定日期；农历节日（春节、中秋等）没有硬编，避免每年算错。

**遗留**：

- `ensureAll` 与 `feeds.ensureDay` 还没有生产调用点，等调度票在启动与 08:30/09:00 接上；`world_feeds` 的 90 天清理也还没接到启动清理里。
- `life_events.used_by_msg_id` 的写入路径在主动消息提交时才有，本票只提供仓库函数。
- 天气 / 头条源是硬编码白名单，没有重试、没有跨天缓存；源失效时当天就是没有这类素材。
- “她的今天”抽屉页面还没做，四个页签一起做；本票只交付接口与模块。

