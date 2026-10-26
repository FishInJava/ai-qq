# 0002: 零运行时第三方依赖；node:sqlite 取代 better-sqlite3；纯 JS + JSDoc，无构建

**Status:** accepted

**Context:** 上游选型（spec §11、PRD 4.5）写的是 `better-sqlite3`。但那是一个原生模块：需要 node-gyp / 预编译二进制，Windows 上换 Node 版本、换机器、离线安装都会踩坑；而这个产品的分发形态恰好是"一个人在自己机器上 `node src/index.js` 常驻"，原生编译失败就是产品装不上。当前运行时是 Node v24.11.1，内置 `node:sqlite` 的 `DatabaseSync` 已能覆盖本项目的全部需求（单文件、WAL、事务、prepared statement），且启动即用。

同时，界面已由原型确定为单页 HTML + 原生 JS，仓库里没有任何构建链需求；引入 TypeScript 意味着 `tsc`/打包器/`dist` 目录与"改一行要等编译"，与"一周跑通 M0–M6"的节奏冲突。

**Decision:**

1. 运行时依赖为零。允许的库只有 `node:` 内置：`node:http`、`node:sqlite`、`node:crypto`、`node:fs`、`node:path`、`node:os`、`node:url`、`node:test`、`node:assert`、`node:zlib`。
2. 存储层用 `node:sqlite`（`DatabaseSync`），开 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`；SQL 只出现在 `src/store`。
3. 源码为 ESM `.js`（`"type": "module"`），类型信息用 JSDoc 标注，不引入 `tsconfig`、不产出 `dist`、不做转译。
4. 前端同理：`web/index.html` + 原生 ES module，由进程静态送出，无打包器。
5. 测试用 `node:test` + 内置 `fetch`，不引入 vitest/jest/playwright。
6. 启动脚本加 `--disable-warning=ExperimentalWarning`（`node:sqlite` 目前仍打实验性警告），仅屏蔽该类警告，不屏蔽其他。

**Consequences:**

- 好处：`git clone` 后不需要 `npm install` 就能跑；没有原生编译、没有 lockfile 冲突、没有安全审计负担；依赖升级风险归零。
- 代价：需要自己写多段上传体读取、SSE 帧拼装、静态文件 MIME、事件总线（各几十行）；`node:sqlite` 的实验性 API 未来可能变动。
- 风险与退路：若 `node:sqlite` 在实现期出现阻塞级缺陷，**只改 `src/store`**（换 `better-sqlite3`，repo 函数签名不变），并以 successor ADR 记录，不做全局重构。这是把风险关在一个模块里的原因。
- 触发人类同意的条件：新增任何第三方依赖（含 devDependency），都要先改本 ADR 并取得批准。
