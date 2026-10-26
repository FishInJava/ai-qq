# 03: M1 无损导出与删除两档

**What to build:** 用户能把库里的卡按原样导出：JSON 直出原始卡片文本，PNG 复用原图字节、只重写 `chara` 块，导出的 `extensions` 与导入前逐字节一致；也能删卡，并在二次确认里选「仅删卡」或「连对话记录一起删」。

**Blocked by:** 02（M1 角色卡导入、角色库与开始聊天）

**Status:** done

- [x] `GET /api/cards/:id/export?format=json` 直出 `card_json` 原始字节，`Content-Disposition` 文件名由卡名白名单化
- [x] `GET /api/cards/:id/export?format=png` 复用原图字节，仅把 `tEXt` key=`chara` 块重写为原始卡片文本的 base64，其余 chunk 逐字节保留；未改动的卡导出结果与原图完全一致
- [x] JSON 导入的卡请求 PNG 导出时用占位图包住同一份原始文本；未知 `format`、卡不存在都返回明确中文错误，不产生半截文件
- [x] `DELETE /api/cards/:id?scope=card` 删除角色、原卡文件与头像，保留 `sessions` 与全部记录（`sessions.character_id` 置 NULL）
- [x] `DELETE /api/cards/:id?scope=records` 删除角色与文件，并级联清理会话、消息、facts、summaries、life_events、proactive_log、daily_budget、token_ledger、scheduler_state；会话为 `active` 时先置 `paused`
- [x] 页面提供导出 PNG / JSON 与删除入口；删除弹窗含范围选择与中文确认文案，不出现系统腔
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：卡能原样出去，也能按两种范围删干净；导出是 T10 的验收面。

改动面：`src/cards/{index,png}.js`、`src/http/routes/cards.js`、`src/store/repo/sessions.js`、`src/store/index.js`、`web/{index.html,styles.css,app.js}`、`test/helpers/card-fixtures.js`、`test/s1/t03-card-export-delete.test.js`、本票。

同意项：无新增依赖；`GET /api/cards/:id/export` 与 `DELETE /api/cards/:id` 均已在 ARCHITECTURE §6.1 的契约里，不新增字段。

已确认：
- `scope=card` 保留会话与记录，`sessions.character_id` 置 NULL；人已确认按 spec D-12 执行。
- JSON 导入的卡没有原图，请求 `format=png` 时用纯色占位图包住同一份原始文本；人已选择此方案，不返回错误。

**落地**：`png.js` 增加 `replaceCharaText()` 与 `makePlaceholderPng()`：前者按 chunk 遍历，只替换 `tEXt` key=`chara`，其余 chunk（IHDR/IDAT/pHYs/IEND 等）原样拷贝，找不到 chara 时在 IEND 前补一个；后者生成 160×160 纯色 PNG，颜色由卡片文本哈希决定，同一张卡每次导出一致。`cards.exportCard()` JSON 直吐 `card_json` 字节，PNG 读原卡文件重写 chara 块；JSON 卡走占位图。文件名对 `\u0000-\u001f`、`<>:"/\|?*`、首尾点做白名单化，中文名用 `filename*=UTF-8''` 下发。`cards.remove()` 在一个事务里按范围删除：`card` 只删角色（FK 把会话 `character_id` 置 NULL），`records` 先把 `active` 会话置 `paused`，再删会话触发级联，最后删角色；文件在事务后清理。前端角色库每张卡新增导出/删除小按钮；导出弹窗可选 PNG/JSON，下载走 `Content-Disposition` 文件名；删除弹窗可选范围，活跃会话会多一句提醒。

**验证**：本机与主C（`G:\0ALLInAI\0DSHtemp\Testproduct`，Node v24.11.1）均通过：`npm run check` 无输出；`npm test` 23/23 绿（本票 9 条：JSON 逐字节、PNG 原图逐字节、JSON→PNG 占位图、V1 逐字节、T10 五张 V2 卡、错误分支、仅删卡、连记录删除、重复删除）；`npm run smoke` 退出码 0（本次主C port 51381）。本机另用 Chrome headless CDP 验证：角色库显示导出/删除按钮，导出 JSON 实际落盘 `删除卡.json`，删除选「连对话记录一起删」后卡片从库中消失，全程无 console 异常。

**偏差**：
- JSON 卡导出 PNG 使用占位图（人已确认）。占位图不是原图，但 `chara` 块里的卡片文本与原卡逐字节一致，重新导入仍命中同一 hash。
- `format` 缺省按 `json` 处理；`scope` 缺省按 `card` 处理，避免无参数请求直接连记录一起删。

**遗留**：`scope=card` 留下的孤儿会话不会出现在角色库，也没有入口再查看；重新导入同一张卡会新建角色与会话，不会自动接回旧记录（spec 只要求“保留”，未要求“接回”）。等 M2 消息流或 M6 数据管理票再决定是否提供孤儿记录入口。下一步 M2：对话流、LLM 客户端与 fake-llm。
