# 0004: HTTP/SSE 是唯一测试缝；测试栈 = node:test + fetch + 假 LLM 进程

**Status:** accepted

**Context:** 仓库是绿地，没有任何测试代码（spec "先例"一节已确认）。同时这个产品最容易"测了个假"的地方是：直接断言内部函数、断言表结构、mock 掉 HTTP 层——那些测试全绿，而用户看到的界面仍然是错的。另一个坑是引入重量级测试框架与浏览器自动化，在 M0 当天就要维护两套运行环境。

**Decision:**

1. 主测试缝 **S1**：起一个真实子进程（临时数据目录 + 随机端口），只通过 HTTP/SSE 断言。断言对象是"页面能看到的东西"：状态码、响应体、SSE 事件序列、抽屉接口返回的 tick 留痕、导出字节。
2. 上游测试缝 **S2**：本地假 OpenAI 兼容服务（`tools/fake-llm`），可编排正常流 / 连续 5xx / 超时 / 缺 usage / 返回无锚点 / 返回超长整段 / 返回系统腔。通过配置注入其 `base_url`。
3. 时间缝 **S3**：假时钟 + 显式 `POST /api/test/tick`（`config.runtime.test_hooks=true` 才挂载）。
4. 测试栈只允许 `node:test`（runner）+ 内置 `fetch`（HTTP 客户端）+ `child_process`（起进程）+ 临时目录夹具。**不引入第二个 runner、第二个断言库、浏览器自动化。**
5. 不许断言内部函数、表结构与日志文本；可读 DB 只用于排障，不作为断言依据。
6. 任何等待真实时间、任何 `sleep > 2s` 的用例视为设计错误（spec Testing Decisions 原文）。

**Consequences:**

- 好处：测试即"用户视角契约"，重构内部实现不会让测试变红；用例名可以写成"用户看到什么"。
- 代价：每个用例要付一次进程启动成本（约 100–300ms），用例数上来后需要并行跑（`node --test --concurrency`）。
- 代价：SSE 断言要自己写帧解析（几十行），不做抽象层。
- 影响面：`test/s1|s2|s3`、`test/helpers/*`、`tools/fake-llm`；对外契约一旦改动，`test/s1` 与 `web/` 必须同时改（§6 表）。
