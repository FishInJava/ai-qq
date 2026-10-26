# 0006: 无 Electron；托盘与自启走 PowerShell 辅助进程

**Status:** accepted

**Context:** PRD 3.12 要求 Windows 托盘（打开页面/暂停所有会话/退出）、开机自启、单实例与崩溃节流。直觉方案是 Electron 或 Tauri，但那会把一个"单文件 Node 常驻进程"变成上百 MB 的应用包，并引入渲染进程与主进程通信的一整层架构——而我们的界面本来就是一个由进程自己送出的网页。为托盘付出这个代价不划算，且会污染"页面只是消费者"这个边界。

**Decision:**

1. 不引入 Electron / Tauri / 任何 native 外壳。产品形态就是 `node src/index.js` 常驻进程 + 一个浏览器页面。
2. 托盘由 `src/runtime/tray.ps1`（PowerShell + WinForms `NotifyIcon`）实现，作为**独立的辅助进程**由主进程拉起：它读 `data/runtime.json` 拿端口与 pid；"打开页面"由托盘自己 `Start-Process` 打开 `http://127.0.0.1:<port>`（不经 HTTP），"暂停所有会话"与"退出"分别调 `/api/admin/pause-all` 与 `/api/admin/quit`。托盘崩溃不影响主进程。
3. 开机自启：写入当前用户的启动目录（`shell:startup` 的 `.lnk`）或注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，二选一由首次运行决定并写日志；失败只告警 + 页面提示手动配置方式，不阻断启动。
4. 崩溃重启节流：`tools/run-companion.ps1` 负责"启动 → 等退出 → 若 exit 42 且 1 小时内 <3 次则重启"，主进程只保证干净退出并写现场。进程内不自重启（Node 无法可靠重启自身）。
5. 非 Windows 平台不实现托盘与自启；进程与页面照常可用。

**Consequences:**

- 好处：零原生依赖、零打包、零安装器；托盘只是可选的附加进程，删掉它产品仍然完整。
- 代价：托盘菜单能力受 PowerShell 限制（无富图标、无气泡通知定制）；自启在杀软环境下可能被拦（有降级路径）。
- 代价：`/api/admin/*` 三个运维路由必须校验 `Host` 且仅本地可达（见 ARCHITECTURE §10）。
- 放弃：Electron 打包、安装器、自动更新、跨平台统一托盘。
- 影响面：`src/runtime/{tray.ps1,autostart.js,supervisor 调用}`、`tools/run-companion.ps1`、`http/routes/admin.js`。
