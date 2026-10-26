# 02: M1 角色卡导入、角色库与开始聊天

**What to build:** 用户把 SillyTavern 的 PNG 或 JSON 角色卡拖进页面，先看到名字、描述、标签、兼容模式与脚本/世界书提示；确认后卡落库并出现在角色库；点「开始聊天」后会话从 `unstarted` 进入 `active`。解析失败时不落库。

**Blocked by:** 01（M0 骨架）

**Status:** done

- [x] `POST /api/cards/preview` 支持 PNG（`tEXt` key=`chara`）与 JSON，返回名字、描述、标签、compat、has_scripts、has_book、duplicate
- [x] 无 `chara` 块的 PNG / 非法 JSON 返回明确中文错误，角色库不新增
- [x] `POST /api/cards/commit` 落库 `characters` + `sessions(unstarted)`，保存原卡副本与 PNG 头像；同 hash 的 `mode=new` 返回 409，`mode=overwrite` 更新卡面并保留原会话
- [x] `GET /api/cards` 返回角色库列表：状态叙事词、今日剩余主动额度、最近消息、`avatar_url`，支持 `q` 按名字筛选
- [x] `POST /api/cards/:id/start` 将 `unstarted` 改为 `active`，写入默认 `token_limit`
- [x] 页面可拖入/选择文件、预览、确认、在角色库看到卡片并开始聊天
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：用户能把卡拖进来，看到预览，落库，并在角色库点开始聊天。

改动面：`src/cards/*`、`src/library/*`、`src/session/state.js`、`src/store/repo/{characters,sessions,messages,budget}.js`、`src/http/{router,respond,routes/cards}.js`、`web/*`、`test/{helpers,s1}`、本票。

同意项：无新增依赖；新增 `GET /api/cards/:id/avatar` 是 `avatar_url` 字段的必要落点，不改已有契约字段。

验收命令：`npm test`、`npm run check`、`npm run smoke`；另手工拖入一张 PNG 与一张 JSON。

**落地**：`cards` 做成两段式——`preview` 只在内存留 5 分钟一次性令牌（含原始字节、`sha256(原始 JSON 文本)`、解析结果），`commit` 才在一个事务里写 `characters` 与 `sessions(unstarted)`，并把原卡文件落到 `data/cards/<id>.<png|json>`、PNG 头像落到 `data/avatars/<id>.png`。PNG 只读 `tEXt` 的 `chara` base64；JSON 直读；`spec = chara_card_v2` 走 V2 映射，其余按 V1 六字段读并标 `compat=v1`。同 hash 的 `new` 返回 409，`overwrite` 复用原角色 id 与原会话、只更新卡面；同名不同 hash 正常并存。`library` 组装状态词、今日剩余额度与最近消息；`session` 只允许 `unstarted → active`，重复开始幂等。前端有拖拽/选择、解析中、预览、重复确认、错误四种状态，角色库可搜索、可开始聊天。

**验证**：本机与主C（`G:\0ALLInAI\0DSHtemp\Testproduct`，Node v24.11.1）均通过：`npm run check` 无输出；`npm test` 14/14 绿（S1 健康 3 条 + 本票 11 条）；`npm run smoke` 退出码 0（本次主C port 65131）。另用 Chrome headless CDP 跑完整页面链路：导入预览 → 确认落库 → 角色库出现 → 开始聊天显示「醒着」，无 console 异常。

**偏差**：
- `GET /api/cards` 的 `unread` 恒为 `0`：12 表模型里没有“已读”状态列，M1 不擅自加表/加列；等 M2 消息流落地时再按真实已读口径补。
- 列表的 `today_remaining` 由 `quota.remainingToday()` 按 `daily_budget` + 配置预算即时计算；`unstarted` 会话也返回数值，但前端不显示额度角标。
- 预览令牌同时最多保留 8 个，超出按最早创建淘汰；这是内存防护，不改变契约。

**遗留**：无损导出（JSON 直吐原文 / PNG 复用原图字节只重写 `chara` 块）、删除两档 `scope`、以及 `sessions.character_id` 可空 + `ON DELETE SET NULL` 的人工确认，放进下一张 M1 票。`npm run fake-llm` 仍指向 M2 的 `tools/fake-llm/server.js`。
