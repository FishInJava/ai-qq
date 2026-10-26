# 17: 导入入口收敛为一个

**What to build:** 页面上任何时刻只有一个导入角色卡的入口——角色库头部那个常驻图标按钮。左下角的导入区删掉，舞台中央那个随状态消失的按钮也并入常驻位置。

**Blocked by:** 16

**Status:** done

- [x] 空库时页面上只有 1 个导入入口
- [x] 已选卡但未开始时仍只有 1 个，且可点
- [x] 聊天中仍只有 1 个，且可点
- [x] `importZone`（左下角）已删除，`.rail__foot` 与 `.import-zone*` 死样式一并清理
- [x] `importOpen`（头部十字，PR #2 已删）不再回来
- [x] 拖拽导入不受影响（绑定在 `document` 上，不依赖被删元素）
- [x] `npm run check` 无输出；`npm test` 107/107；`npm run smoke` 退出码 0

## Notes

**目标**：导入入口从 2 个收敛成 1 个，且任何状态下都不缺。

**复现证据（改前，空库，实测抓首页 HTML）**：

| 元素 | 数量 | 位置 | 初始 hidden |
|---|---|---|---|
| `importZone` | 1 | `rail__foot` | 无 → **永远可见** |
| `stageImport` | 1 | `stageEmpty` | 无 → 随「是否选卡」显隐 |

两者都无 `hidden`，空库时同时可见。而 `importZone` 在 `renderStage()` 里从未被设置 `hidden`，是唯一常驻入口；`stageImport` 随 `stageEmpty.hidden = card !== null` 消失。

**上一版的错误**：PR #2 删的是 `importOpen`（头部十字），那是第三个入口。删完从 3 个变 2 个，没达成「1 个」。且当时没有复现，测试断言写的是被删的那个，不是真正的重复项。

**修法（用户选定 B）**：删 `importZone`，把 `stageImport` 从 `stageEmpty` 移到 `rail__actions`，做成常驻图标按钮，与「模型设置」「关闭」并排。这样它不再随舞台切换消失，三种状态都只有这一个。

**改动面**：
- `web/index.html`：删 `rail__foot` 整块；`stageImport` 移到 `rail__actions`，从文字按钮改图标按钮
- `web/app.js`：删 `importZone` 的 `els` 引用与事件绑定；删 `stageImport` 的 `textContent` 赋值（图标按钮无文字）
- `web/styles.css`：删 `.rail__foot`、`.import-zone`、`.import-zone__icon`、`.import-zone strong/small`
- `test/s1/t16-chat-time-and-import-entry.test.js`：重写入口用例，覆盖三种状态

**验证**：
- `npm run check` 无输出
- `npm test` 107/107 全绿
- `npm run smoke` 退出码 0（端口 59623）
- 实测三态：空库 / `unstarted` / `active`，`stageImport` 计数均为 1，`importZone` 与 `importOpen` 计数均为 0

**偏差**：与原型的偏离——原型左下角有 `importZone`、舞台中央有 `welcomeImport`，本票按用户要求收敛为一个常驻图标按钮，不跟随原型。

**遗留**：
1. 导入弹窗内部仍有 `importConfirm` / `importOverwrite` 两个按钮，那是弹窗内的流程动作（新建 vs 覆盖），不是重复入口。
2. 拖拽提示文案「把卡拖进来 / PNG / JSON · 单张 ≤20MB」随 `importZone` 一起消失；如需保留提示，应在别处补一行静态说明。
