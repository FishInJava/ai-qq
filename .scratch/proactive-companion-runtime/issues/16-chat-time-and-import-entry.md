# 16: 聊天消息显示时间；导入入口去重

**What to build:** 聊天里每条消息上方显示本地时间（`HH:mm`），跨天时插一条「今天 · 10月26日」这样的日期分隔行——和原型一致。同时角色库头部那个重复的导入十字按钮去掉，导入只保留左下角一个入口。

**Blocked by:** 14（M7 前端模型设置入口）

**Status:** done

- [x] 每条消息（用户与角色）上方显示本地 `HH:mm`，同一条回复的多个气泡共享同一时间
- [x] 跨天时插入日期分隔行，措辞为「今天 · M月D日」/「昨天 · M月D日」/「M月D日」
- [x] 时间由服务端算好下发（`clock_text` + `local_day`），页面不做任何日期运算、不引入定时器
- [x] `user_ack` 与 `bubble` 事件都带 `created_at` / `clock_text` / `local_day`；`GET /api/sessions/:id/messages` 同样返回这三个字段
- [x] `/health` 增加 `today` / `yesterday`，页面据此决定「今天/昨天」措辞
- [x] 角色库头部移除重复的导入十字按钮（`importOpen`），导入只保留左下角 `importZone`
- [x] `npm run check` 无输出；`npm test` 107/107；`npm run smoke` 退出码 0

## Notes

**目标**：聊天能看出「什么时候说的」；导入入口不再有两个。

**改动面**：
- `src/clock/index.js`：新增 `localClockText(iso)` → 本地 `HH:mm`
- `src/chat/index.js`：`messageView` 增加 `clock_text` / `local_day`；`user_ack` 与 `bubble` 事件同步下发
- `src/http/index.js`：`/health` 增加 `today` / `yesterday`
- `web/app.js`：`messageHtml` 渲染时间与日期分隔行；`loadToday()` 启动与聚焦时读 `/health`；移除 `importOpen` 绑定
- `web/index.html`：删除头部导入十字按钮
- `web/styles.css`：`.msg` 改纵向、新增 `.msg__meta` 与 `.day`
- `docs/ARCHITECTURE.md` §6.2/§6.4：契约补 `created_at` / `clock_text` / `local_day`
- `test/s1/t16-chat-time-and-import-entry.test.js`：两条用例

**同意项**：A2（改 §6 对外契约，SSE 事件增字段）。已按 `Rule.md §8-A2` 同步 `docs/ARCHITECTURE.md §6`、`web/`、`test/s1` 三处。字段是**纯增量**，不删不改既有字段，旧消费方不受影响。

**过程中被门禁拦下的一次**：第一版在 `web/app.js` 用 `new Date` 做本地时间换算，`npm run check` 直接报「页面不能承担定时」。这是硬规则 1（页面永不定时）在起作用——改成由 `clock` 算好下发。**记一笔：时间换算必须留在服务端。**

**验证**：
- `npm run check` 无输出
- `npm test` 107/107 全绿（新增 2 条）
- `npm run smoke` 退出码 0（端口 62200）
- 新增用例覆盖：SSE 三类事件都带 ISO 时间戳、同批气泡时间戳一致、历史接口带时间、页面只有一个导入入口且脚本不再绑定 `importOpen`

**偏差**：无。

**遗留**：
1. 跨零点后「今天/昨天」措辞会旧，靠窗口 `focus` 时重读 `/health` 刷新，不做定时器（硬规则 1 的代价）。
2. 原型头部有「主题切换」按钮，当前实现没有——原型与实现的既有差异，不在本票范围。
3. 日期分隔行的 `::before/::after` 细线是本次新增的视觉处理，原型 `.day` 只有文字；如需严格对齐原型可去掉。
