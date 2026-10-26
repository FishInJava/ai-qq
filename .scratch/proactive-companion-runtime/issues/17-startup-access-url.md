# 17: npm start 后在控制台显示访问地址与端口

**What to build:** 用户运行 `npm start` 启动成功后，控制台（stdout）明确打印一行可点击/可复制的本机访问地址，包含实际监听端口（端口 0 自动分配、或被占用递增时也要显示真实端口）。用户不用去翻 `data/runtime.json` 就知道在浏览器打开哪里。

**Blocked by:** 16

**Status:** done

## 复述

- 目标：用户启动进程后第一眼看到访问地址（如 `http://127.0.0.1:3000`）。
- 改动面：`src/runtime/index.js`（组合根，HTTP start 之后写 stdout；是全项目唯一允许写 stdout 的位置，check.js 已豁免 runtime）。不新增依赖、不改 HTTP 绑定（仍只绑 127.0.0.1）。
- 同意项：无。
- 验收命令：`node --test test/s1/t17-startup-url.test.js`、`npm test`、`npm run check`、`npm run smoke`。

## 验收项

- [x] 启动成功后 stdout 出现一行访问地址，形如 `打开页面：http://127.0.0.1:<port>`；`<port>` 是实际监听端口（端口 0 时为系统分配端口）。
- [x] 该输出对每个真实进程只出现一次；启动失败不输出假地址（错误仍走 stderr）。
- [x] 基线 107 条 + 本票 1 条 = 108 全绿；smoke 退出码 0；`npm run check` 无输出（业务模块仍不许 console.*）。

## Notes

**落地**：`src/runtime/index.js` 在 `http.start()` 并写好 `runtime.json` 之后向 stdout 打印一行 `她已经醒着了，打开页面：http://127.0.0.1:<port>`，用的是 http.start 返回的实际端口。组合根是 check.js 唯一豁免 `process.*`/stdout 的位置，没有动绑定（仍只绑 127.0.0.1），也没加依赖。

**验证**：新增 `test/s1/t17-startup-url.test.js`（真实进程，断言 stdout 恰好一个 `http://127.0.0.1:<真实端口>` 且该地址 /health 200）；先红（stdout 为空）后绿。`npm test` 108/108、`npm run check` 无输出、`npm run smoke` 退出码 0。

**偏差**：无。
**遗留**：无。
