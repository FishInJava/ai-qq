# 06: M2 长对话：20 轮不断线、上下文裁剪与用量回归

**What to build:** 连续聊 20 轮（40 条消息）时，每一轮都能正常拿到回复；上下文按 `context_budget` 裁掉最旧原文而不是整段失败，摘要与当前这句话始终保留；历史、token 账本与页面滚动都不丢。

**Blocked by:** 05（M2 对话流：发消息、风格后置过滤、历史与全局事件）

**Status:** done

- [x] `chat.buildContext` 在超出 `config.llm.context_budget` 时先丢最旧原文、再丢超过 5 条的 facts，摘要永不丢；无论预算多小都至少保留当前这一条用户消息
- [x] S2：连续 20 轮 user → char 全部以 `done` 结束，没有 `llm_*` / `style_blocked` / `internal` 错误；`GET /api/sessions/:id/messages` 能分页取回全部 40 条
- [x] 每轮 `token_ledger` 各记一条 `chat`，`sessions.token_used` 等于账本累计；`last_user_msg_at` 随最后一轮更新
- [x] S2：把 `context_budget` 压到很小并塞入长消息，断言发给模型的上下文不含最旧原文、facts 不超过 5 条、最新用户消息一定在
- [x] 页面：40+ 条消息时列表可滚动，发送后自动滚到底；刷新后历史顺序仍是从旧到新
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：把 M2 的完成定义补齐——T1/T2 已经绿，剩下“20 轮不断线”。本票不引入摘要生成（M3）、不做主动消息（M4），只验证并加固现有 `chat` 的长对话路径。

改动面：`src/chat/index.js`、`test/s1/t06-long-chat.test.js`、`test/s2/t06-context.test.js`、必要时 `web/app.js`（只做滚动/顺序修正）、本票。

约定：
- “20 轮”按 20 次用户发言计，共 40 条消息；历史接口默认 `limit=50`，一页即可取回。
- 裁剪顺序照 ARCHITECTURE §4.9 / spec D-6：先丢最旧原文 → 再丢超 5 条 facts → 摘要永不丢。最新一条用户消息是硬保留项，即使它自己就超预算也不丢，只记日志。
- 本票不新增路由、不新增配置字段；`context_budget` 继续读 `config.llm.context_budget`。

验收命令：`npm test`、`npm run check`、`npm run smoke`；另起进程连发 20 轮，确认页面不卡、刷新后顺序正确。

**落地**：

- `src/chat/index.js` 的裁剪循环从 `recentCount > 0` 改成 `recentCount > 1`：无论预算多小，最后一条（也就是刚插入的当前用户消息）一定留在上下文里；仍超预算时只写 `chat_context_over_budget` 日志，不静默丢掉用户这句话。
- `tools/fake-llm/server.js` 增加 `/__last`，返回最近一次请求的 `{ model, messages, stream }`；`test/helpers/fake-llm.js` 补 `lastRequest()`，供上下文断言使用。这个接口只服务测试与手工联调，不进入生产路径。
- 新增 `test/s2/t06-context.test.js`：用假 store 直接调 `chat.buildContext`，覆盖 20 轮长消息裁剪、摘要永不丢、facts 先被丢、facts 最多 5 条。
- 新增 `test/s1/t06-long-chat.test.js`：真实进程 + 假供应商连发 20 轮，断言 40 条历史、20 条 `chat` 流水、`token_used` 等于流水累计、`last_user_msg_at` 已更新。
- 页面不需要改代码：`renderMessages()` 每次追加后把 `chatBody.scrollTop` 设到 `scrollHeight`，40 条消息时仍会自动到底。

**验证**：本机与主C（`G:\0ALLInAI\0DSHtemp\Testproduct`，Node v24.11.1）均通过：`npm run check` 无输出；`npm test` 50/50 绿；`npm run smoke` 退出码 0（主C 本次 port 55155）。本机另用 headless Chrome + CDP 预置 20 轮后打开页面：40 条消息顺序从“第1轮”到最后一条她的回复，滚动条在底部；再从页面发一句，消息变 42 条且仍自动到底，控制台无异常。

**偏差**：

- 票里写“facts 不超过 5 条”，实现仍由 `store.facts.listPending(sessionId, 5)` 保证；S2 用假 store 喂 8 条来确认调用方真的只取 5 条，而不是在 `chat` 里再截一次。
- 上下文 token 仍是字符数估算（`ceil(chars / 2)`），没有接真实 tokenizer；本票只保证裁剪顺序与硬保留项，不改变估算口径。

**遗留**：

- 摘要生成仍不在本票（M3）。现在“摘要永不丢”只在有摘要行时成立；空表时自然只剩人设、facts 与最近原文。
- 长对话只验证到 20 轮；更大规模（例如 200 轮）仍依赖 `RECENT_CONTEXT_MESSAGES = 40` 与预算裁剪，没有单独的压测。
- 页面消息列表是一次性 `innerHTML` 重建；40 条没问题，消息上千后需要改成增量插入或虚拟列表。

