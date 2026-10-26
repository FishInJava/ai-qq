# 14: M7 前端模型设置入口

**What to build:** 用户不打开 `data/config.json`、不改代码，就能在页面上填模型地址、密钥、对话模型与小模型名并保存；保存后下一次对话立刻用新配置，不需要重启进程。密钥永远只回后四位，界面上没有任何"额度 / 配额 / 余额"字样，也没有风格开关。

**Blocked by:** 11（M5 会话全态、续额、用量、配置与清空数据）

**Status:** done

- [x] 角色库头部出现"模型设置"入口（齿轮图标 + `aria-label`），点开是 `<dialog>`，按 `Escape`、关闭按钮或遮罩关闭，沿用现有暖色视觉与 760px 断点
- [x] 设置弹窗读取 `GET /api/config`：地址、密钥、对话模型、小模型四个字段；密钥输入框为空，占位显示"已保存 ****abcd，留空不改"，不回显明文
- [x] 保存走 `PUT /api/config`，只提交 `llm` 四个字段；密钥留空时不覆盖已存密钥；成功后关闭弹窗并提示已保存
- [x] 保存失败（400 / 服务不可用）时弹窗不关闭，把 `error.message` 显示在表单内，按钮恢复可用
- [x] 弹窗含 spec D-15 要求的静态说明"内容由模型生成，请自行判断"；不出现风格开关、供应商选择、备用通道
- [x] `llm` 每次调用都读当前 `config.llm`，保存后不需要重启；新增用例证明换模型后下一次流式请求的 `model` 变了
- [x] 页面不承担定时、不写库、不做本地存储；所有动态文本经 `esc()` / `textContent` 转义
- [x] S1：页面包含入口与四个字段；空密钥保存后磁盘仍是原密钥；换 `chat_model` 后下一次对话用新模型；非法字段 400 且不写盘
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

**目标**：把已有的 `GET/PUT /api/config` 接到页面上，让"配模型"从改文件变成点两下。

**改动面**：`web/index.html`（入口 + 弹窗）、`web/app.js`（读取/保存/错误态）、`web/styles.css`（表单）、`src/llm/index.js`（配置改为调用时读取）、`test/s1/t14-model-settings.test.js`。

**同意项**：无。复用 §6 已有契约（`GET/PUT /api/config`），不新增路由、不加依赖、不动数据模型、不加风格开关。

**验收命令**：`node --test test/s1/t14-model-settings.test.js` → `npm test` → `npm run check` → `npm run smoke`。

**发现的实现缺陷**：`createLlm` 在构造时 `const llmConfig = config.llm` 抓住了对象引用，而 `configService.update` 是整体替换 `config.llm`，所以此前任何经 API 保存的模型改动都要重启才生效。本票一并修掉（改为调用时读 `config.llm`），否则"前端配置模型"这个需求本身不成立。

**落地**：`web/index.html` 角色库头部加齿轮入口与"模型设置"弹窗（接口地址 / 密钥 / 对话模型 / 小模型 + "内容由模型生成，请自行判断"静态说明）；`web/app.js` 加读取、保存、失败态与"未读到配置不允许保存"的保护；`web/styles.css` 加表单样式；`src/llm/index.js` 改为每次调用读取当前 `config.llm`，保存即生效、无需重启；新增 `test/s1/t14-model-settings.test.js` 三条用例；`docs/ARCHITECTURE.md §11` 与 `AGENTS.md` 状态行同步。

**验证**：
- `npm run check` 无输出；`npm test` 105/105 全绿；`npm run smoke` 退出码 0（端口 56777）。
- 浏览器实机（1280×860 与 390×780 两档）：入口可见，弹窗回填地址/两个模型名，密钥框为空且提示"已保存 \*\*\*\*abcd，留空不改"；改对话模型后保存 → 弹窗关闭 + toast"已保存，下一句就用新配置"，磁盘上 `api_key` 仍是原值、`chat_model` 已更新；`Escape` 可关；杀掉进程后点保存 → 弹窗保持打开、表单内显示"服务没有响应，请稍后再试"、按钮恢复可用、输入内容未丢。

**偏差**：设置页只放模型四项；城市、自启、端口等仍需改 `config.json` 或重启，不在本票范围。

**审查修正（本次提交前）**：
1. 上面验收项曾勾选"遮罩关闭"，但 `web/app.js` 只绑了关闭按钮与 `Escape`，点遮罩不会关。已补 `settingsDialog` 的 `click` 判 `event.target === dialog`，且保存中不响应。
2. 弹窗只有 `aria-haspopup`/`aria-controls`，缺 `aria-modal` 与初始焦点。已补 `aria-modal="true"` 与打开时聚焦接口地址输入框。
3. 本段原有两个 `## Notes`（前一个是探索记录，后一个是落地记录），合并为一。

**遗留**：密钥只能整体替换，没有"清空密钥"的显式操作；`server.port` 与 `runtime.test_hooks` 仍返回 `restart_required`，页面对此只做提示而不自动重启。
