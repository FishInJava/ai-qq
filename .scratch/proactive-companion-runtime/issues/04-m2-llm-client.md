# 04: M2 LLM 客户端与本地假供应商

**What to build:** 配好 `base_url` / `api_key` / `chat_model` 后，运行时能通过 OpenAI 兼容接口拿到流式回复；本地假供应商能顶替真实模型，按剧本返回正常流、5xx、超时、缺 usage、超长整段或系统腔，供测试与离线联调。

**Blocked by:** 03（M1 无损导出与删除两档）

**Status:** done

- [x] `npm run fake-llm` 起本地 OpenAI 兼容服务：`POST /chat/completions` 同时支持 `stream: true|false`，流式按 `data:` 帧返回 delta 与 usage，以 `[DONE]` 结束；端口与剧本可由启动参数/环境变量控制
- [x] `src/llm/index.js` 暴露 `chatStream` / `chatOnce` / `json`；`chatStream` 产出 `{ delta }`、`{ usage }`、`{ done }`
- [x] 端点固定 `POST {base_url}/chat/completions`；流式带 `stream_options.include_usage`；对话 30s、工具 10s 超时，超时抛 `llm_timeout` 且不落库
- [x] 429/500/502/503/504 重试 2 次（1s/3s 退避）；4xx 鉴权不重试并抛 `config_invalid`；端点不可用抛 `llm_unavailable`
- [x] `json()` 强制 JSON 并做 schema 校验，坏 JSON / 不符合 schema 抛 `llm_bad_json`；`base_url` 或模型未配置时抛 `llm_not_configured`
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：先把上游这层做稳，M2 的对话编排只依赖 `chatStream` 契约，不直接碰 HTTP。

改动面：`src/llm/index.js`、`tools/fake-llm/server.js`、`test/s2/t04-llm.test.js`、`test/helpers/fake-llm.js`、本票。

同意项：无新增依赖；`src/llm` 的公开面已在 ARCHITECTURE §4.5 固定，不新增配置字段。

**落地**：`createLlm({ config, clock, log })` 只认 `config.llm`，端点固定拼 `{base_url}/chat/completions`，`chat` 走 `chat_model`、`utility` 走 `utility_model`（缺省回退 `chat_model`）。`chatStream` 逐帧解析 `data:`，产出 `{delta}`、末尾 `{usage}`（上游没给就是 `null`）与 `{done:true}`；`chatOnce` 读非流式 `choices[0].message.content`；`json` 在 `chatOnce` 上强制 `response_format: json_object`，解析后跑内置的最小 schema 校验（object/array/string/number/integer/boolean/enum/required/properties/items/minItems）。超时统一用 `clock.setTimer` + `AbortController`，网络失败、非 2xx、坏响应分别映射为 `llm_unavailable` / `config_invalid` / `llm_bad_response`；429/500/502/503/504 退避 1s、3s 各重试一次，仍失败转不可重试的 `llm_unavailable`；`base_url` 或模型名缺失在发请求前就抛 `llm_not_configured`。`tools/fake-llm/server.js` 同时支持流式与非流式，模型名 `fake-*` 选剧本，`--port 0` 把真实端口打到 stdout；`--mode` 或 `FAKE_LLM_MODE` 可强制所有请求走同一剧本，方便手工联调。`test/helpers/fake-llm.js` 负责起停进程、解析端口、读 `/__stats`。

**验证**：本机与主C（`G:\0ALLInAI\0DSHtemp\Testproduct`，Node v24.11.1）均通过：`npm run check` 无输出；`npm test` 33/33 绿（本票 S2 10 条：正常流、缺 usage、flaky 重试 3 次、5xx 耗尽、401 不重试、非流式超时、流式超时、端点连不上、JSON schema 与坏 JSON、未配置）；`npm run smoke` 退出码 0（本次主C port 52569）。本机另手工起 `tools/fake-llm/server.js --port 4199`，curl 验证 `/health`、流式 `data:` 帧（含 usage 与 `[DONE]`）和非流式 JSON 都符合预期。

**偏差**：
- `createLlm` 多一个可选构造参数 `retryDelaysMs`（默认 `[1000, 3000]`），仅供 S2 用 `[0, 0]` 免去真实等待；它不是配置字段，生产行为与 ARCHITECTURE §4.5 一致。票里原计划的“注入立即执行定时器的假时钟”行不通：同一时钟也会让 30s 超时立即触发，正常请求会被误中断。
- 假供应商的剧本默认按 `model` 名选择（测试要按用例切换），`--mode` / `FAKE_LLM_MODE` 只是覆盖入口；票里写“启动参数/环境变量控制”，实现上多了一条按模型名的路径。
- `fake-bad-json` 返回的是“模型正文不是 JSON”，而不是“HTTP 响应本身不是 JSON”；这样 `json()` 才能按契约抛 `llm_bad_json`。HTTP 响应本身坏掉仍归 `llm_bad_response`。

**遗留**：`chatStream` 没有对外暴露取消句柄，调用方中途放弃时只能等超时或读完；M2 对话编排若需要“用户发新消息就中断上一条”，再补 `AbortSignal` 参数。`usage` 缺失时的 token 估算留给 quota 票，本票只如实返回 `null`。下一步：M2 对话流（`chat` + `style` + SSE）。
