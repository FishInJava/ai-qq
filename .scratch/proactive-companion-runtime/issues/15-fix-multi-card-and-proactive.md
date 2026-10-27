# 15: 修复多角色聊天失联与主动消息永不发送

**What to build:** 导入第二张卡后跟她说话能得到回复；一次回复的多条气泡显示成一组；她能在到点时主动开口。

**Blocked by:** 14

**Status:** done

- [x] 主动消息上下文的人设以 `{role:'system'}` 消息对象进入请求体，不再被拍平成 `{}`
- [x] 真实端点（OpenAI 兼容）`tick` 返回 `decision: send`，消息落库 `is_proactive=1` 且锚定生活事件
- [x] 多卡：发送中状态按 `session_id` 记录，切到另一张卡时输入框立即可用
- [x] 一次回复的多条气泡按 `bubble_index` 连续递增合并为一个消息块（`msg--group`）
- [x] 同组气泡在 CSS 上纵向排列（`.msg__bubbles{flex-direction:column}`），不再挤在一行；S1 静态资源回归断言保护
- [x] 聊天流式失败写 `chat_failed` 日志（会话、code、message），不再无声消失
- [x] 回归用例证明：修复前 `messages[0]` 缺 role；修复后人设在场
- [x] `npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

**落地**：
- `src/proactive/index.js`：`assemble()` 首条由裸字符串 `system` 改为 `{ role: 'system', content: system }`，并把 filter 收紧为"必须有 role"。原写法经 `.map(m => ({role: m.role, content: m.content}))` 把字符串拍成 `{role: undefined, content: undefined}`，真实端点以 `MissingParameter: messages.role` 返回 400 —— 主动消息从上线起**从未成功过一次**。
- `src/http/routes/messages.js` + `src/http/index.js`：流式失败写 `chat_failed`，不再只有一条 user 消息留在库里无从排查。
- `web/app.js`：`state.sending` 由全局布尔改为 `Set<sessionId>`；新增 `groupMessages()` 按 `bubble_index` 连续递增分组，同一次回复只渲染一个消息块。
- `test/s1/t15-multi-card-chat.test.js`：三条回归断言合并到一个进程内跑。
- `test/s2/t09-proactive.test.js`：主动上下文预算用例的数值假设建立在旧缺陷上（人设被算成 1 token），按 spec D-6 的真实丢弃顺序重写，并加"人设必须在场"断言。

**验证**：
- 回滚 `proactive` 修复后新用例变红（`messages[0] 缺 role`），修复后转绿 —— 用例确实捕获原缺陷。
- 真实模型 + 真实卡：`tick` → `decision: send`，落库 `is_proactive=1`，内容锚定当日生活事件（"店里到了张难得的 Slayer 黑胶…"）。
- 浏览器实机：切卡后输入框 `disabled=false`、按钮回到"发送"；消息列表 32 条气泡渲染成 26 个块，首块带 `msg--group`。
- `npm run check` 无输出；`npm run smoke` 退出码 0。

**偏差**：无。

**遗留**：`npm test` 在 4 并发下偶发 `应用没有在 3000ms 内启动`（单进程实测启动 780–920ms，属既有 flaky，去掉本票新增用例后同样复现 5/105）。单独跑对应文件必绿。这是测试夹具的启动超时问题，与本票改动无关，需要单独一张票处理。

---

## 追加修复：多条气泡显示在一行（用户报障）

**根因**：分组只改了 `web/app.js` 的 DOM（多条 `.msg__bubble` 直接塞进同一个 `<li class="msg">`），没写对应 CSS。票 16 把 `.msg` 改成 `display:flex; flex-direction:column`，但同组气泡是 `<li>` 的直接子元素、且没有独立包裹容器，分组场景下横向排列（合并前的旧 `.msg` 是默认 row）——一次回复的多条气泡挤在一行。

**落地**：
- `web/styles.css`：新增 `.msg__bubbles{display:flex;flex-direction:column;gap:4px}`（user 侧 `align-items:flex-end`），对齐原型 `.bubbles`。
- `web/app.js`：渲染结构改为 `li.msg.msg--group > .msg__meta + .msg__bubbles > .msg__bubble*`；与票 16 合并后保留时间 meta 与日期分隔行（`dayLabelOf`），组内多气泡只显示一个时间；SSE `user_ack`/`bubble` 帧补存 `clock_text`/`local_day`。
- `src/chat/index.js`、`src/proactive/index.js`：全局 `message` SSE 事件补齐 `clock_text`/`local_day`（合并后与票 16 契约一致）。
- `test/s1/t15`：追加静态资源回归断言（`.msg__bubble` 容器必须 `flex-direction:column`），拿掉该规则时用例如期变红。

**验证**：`npm run check` 无输出；`npm test` 108/108 绿；`npm run smoke` 退出码 0。
**偏差**：无。
