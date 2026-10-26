# 13: M6 常驻化：托盘、开机自启、日志轮转与崩溃守护

**What to build:** 在 Windows 上，主进程起来后能拉起一个独立的托盘辅助进程：打开页面、暂停所有会话、优雅退出；开机自启按配置写入或移除当前用户的启动项，失败只告警不阻断启动；崩溃由外层守护脚本按每小时最多 3 次重启，强杀后重启数据库完好、状态保留、不补发历史消息；日志按大小与天数轮转。

**Blocked by:** 12（M5 细节抽屉）

**Status:** done

- [x] `src/runtime/autostart.js`：`status` / `enable` / `disable` / `sync`；Windows 写当前用户启动项（`HKCU\...\Run`，指向 `data/autostart.cmd`），非 Windows 明确返回 `supported:false` 且不改系统
- [x] 启动时按 `runtime.autostart` 同步自启项；启用/移除失败只写 warn，不阻断 HTTP、调度器与页面
- [x] `src/runtime/tray.ps1`：读 `data/runtime.json` 的 port；菜单提供“打开页面 / 暂停所有会话 / 退出”；打开页面用 `Start-Process`，后两项调用本机 `/api/admin/*`；托盘异常不影响主进程
- [x] `src/runtime/index.js` 仅在 Windows 拉起托盘，退出时回收；非 Windows 跳过；测试环境不拉起
- [x] `tools/run-companion.ps1`：启动 Node → 等退出 → 仅当退出码 42 且本小时重启次数 <3 时重启，其余退出码直接退出；每次重启写清原因
- [x] 日志仍按本地日分文件、10MB 轮转、保留 7 天；补 S1/S2 验证超过阈值后出现 `.1` 归档，旧日期文件被清理
- [x] T14：S1 强杀子进程后重启，断言数据库可打开、会话状态保留、历史消息不重复、不自动补发被动消息
- [x] 非 Windows 上托盘与自启不执行，`npm test` 不因平台跳过；PowerShell 文件做静态存在性与关键动作断言
- [x] `npm test` 全绿；`npm run check` 无输出；`npm run smoke` 退出码 0

## Notes

目标：把已经能跑的常驻进程收成“用户不用开终端也能用”的 Windows 形态。托盘只是可选辅助进程，删掉它主进程与页面仍完整；非 Windows 不实现托盘与自启。

约定：

- **不新增依赖、不改数据模型、不改对外契约**；托盘和守护只用系统 PowerShell / `reg.exe`。
- **自启项内容落地在 `data/autostart.cmd`**：写入正确的 `DATA_DIR` 与工作目录，避免开机时以 `system32` 为 cwd 找错数据库；注册表只保存这个脚本的路径。
- **失败不阻断**：自启失败、托盘启动失败都只写 warn；主进程继续服务。
- **测试不改真实启动项**：`autostart` 的命令构造与文件内容可测；Windows 系统写入只在真实运行且非测试配置时发生。
- **崩溃节流**：主进程只负责 `exit(42)` 与落日志，重启由 `tools/run-companion.ps1` 负责，进程内不自重启。
- **日志轮转维持现有 10MB / 7 天规则**，本票补测试与启动清理覆盖。

### 验证

- 本地：`npm run check` 退出 0；`npm test` 102/102 全绿；`npm run smoke` 退出 0（端口 34205）。
- 主C：`npm run check` 退出 0；`npm test` 102/102 全绿；`npm run smoke` 退出 0（端口 64077）。

### 偏差与遗留

- 自启走注册表 `HKCU\...\Run`，值指向 `data/autostart.cmd`；ADR-0006 允许“启动目录或注册表”二选一，本实现取注册表。
- 测试与冒烟通过 `COMPANION_DISABLE_SHELL=1` 禁止托盘与真实注册表写入；只在真实启动且非测试环境时生效。
- 日志与事件仍分开写；本票只覆盖 `app-*.log` 的 10MB / 7 天规则，`events.jsonl` 维持单文件追加。
- 非 Windows 平台托盘与自启明确 no-op，PowerShell 文件只做静态校验。
- 主C 手工验证：临时数据目录、`autostart:false` 启动后日志出现 `tray_started`，托盘进程存活；调用 `/api/admin/quit` 后托盘进程被回收，`autostart_synced` 为 `supported:true, enabled:false`。
