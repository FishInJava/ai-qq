# 01: M0 骨架：进程起得来、库建得对、页面能确认服务活着

**What to build:** 用户启动进程后，本机 `127.0.0.1` 上有一个常驻服务；首次启动生成配置、日志、单实例锁与 12 张表的数据库；浏览器打开页面能看到占位页，并通过 `/health` 确认服务在线；关掉页面进程仍在。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `npm start` 起进程，`/health` 返回 200，端口与 `data/runtime.json` 一致
- [x] 首次启动创建 `data/companion.db`，12 张表齐全（`schema_version` + 11 张业务表），WAL 与外键开启
- [x] 第二次启动被单实例锁拒绝，并给出“已在运行”的受控提示
- [x] `GET /` 返回占位页；非本机 Host 请求返回 403
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：进程起得来，库建得对，页面能确认服务活着。

改动面：`package.json`、`src/{index,errors,clock,store,runtime,http}`、`web/`、`tools/{check,smoke,db-reset}.js`、`test/{helpers,s1}`、本票。

同意项：无（M0 为 ARCHITECTURE §12 明确规定的脚手架阶段；未新增依赖、未改对外契约、未改数据模型形状）。

验收命令：`npm test`、`npm run check`、`npm run smoke`；另跑一次 `npm start` 手工确认 `/health` 与页面。

**落地**：新增 `package.json`（零依赖、脚本按 AGENTS §3）、`src/index.js`、`clock`、`store`（12 表迁移 + 事务 + 完整性检查）、`runtime`（配置/日志/单实例锁/事件总线/runtime.json）、`http`（Host 校验、`/health`、静态页）、`web/index.html` 占位页，以及 `tools/check|smoke|db-reset` 与 S1 健康用例。用户现在可以启动进程、打开页面确认服务在线，重启时会被单实例锁挡住。

**验证**：`npm run check` 无输出；`npm test` 3/3 绿；`npm run smoke` 退出码 0（本机与主C均跑过）。手工起进程后 `/health` 返回 `{ok:true, version:'0.1.0', port:...}`，`/` 返回 200；`sqlite_master` 为 12 张表，`journal_mode=wal`、`foreign_keys=1`、`schema_version=1`；同一 DATA_DIR 第二次启动输出“已经在运行（pid …）”并退出 1。

**偏差**：
- `npm test` / `test:s1|s2|s3` 的路径从目录改为 glob（`test/**/*.test.js`）。Node 24.11.1 与 24.21.0 都把目录参数当模块解析并报 `Cannot find module`，脚本名未改。
- `sessions.character_id` 设为可空并 `ON DELETE SET NULL`：ARCHITECTURE §5 要求 `scope=card` 删除卡时保留会话与记录，若坚持 PRD 的“必填”就无法同时满足；卡片存在时仍由 UNIQUE 保证一卡一会话。此点需要人在 M1 删除票前确认。

**遗留**：`npm run fake-llm` 指向的 `tools/fake-llm/server.js` 属 M2，当前尚未创建；调度器、托盘、自启、日志轮转的运行时接线分别在 M4/M6 补齐。下一步建议按 M1 拆票：导入预览/落库/角色库 → 无损导出与删除。
