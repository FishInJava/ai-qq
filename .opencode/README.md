# OpenCode 项目配置

## 已安装技能（22 个）

### 第一批：设计与动画（15 个）

来源：`G:\0ALLInAI\1AllSkills\emilkowalski-skills`（Emil Kowalski 的设计/动画技能集）

| 技能 | 用途 |
|---|---|
| `animate` | 从零写 Web 动画（含 `RECIPES.md` 现成实现） |
| `animate-expo` | React Native / Expo 动画（含 `RECIPES.md`） |
| `animation-performance` | 动画掉帧、合成层、主线程问题 |
| `animation-vocabulary` | 反向术语表（"那个弹一下的效果叫什么"） |
| `apple-design` | Apple 式交互与物理感 |
| `ask-sonner` | Sonner toast 库（含 `API.md`） |
| `break-ui` | 用最坏数据压测 UI（含 `CATALOG.md`） |
| `emil-design-eng` | UI 打磨与组件设计哲学 |
| `find-animation-opportunities` | 找该加动画的地方（只读） |
| `improve-animations` | 审计整仓动画并出实施计划（含 `AUDIT.md`、`PLAN-TEMPLATE.md`） |
| `mobile-native` | 让 Web 应用在手机上像原生 |
| `pick-ui-library` | 选前端库（仅手动触发） |
| `prototype` | 一次出多个变体供挑选（含 `PICKER.md`，仅手动触发） |
| `review-animations` | 动画代码评审（含 `STANDARDS.md`，仅手动触发） |
| `write-swift` | 现代 Swift / Swift 6 并发 |

### 第二批：HTML 交付物（7 个）

来源：`G:\0ALLInAI\1AllSkills\effective-html`

| 技能 | 用途 |
|---|---|
| `html` | **唯一入口**，把请求路由到下面 5 个专家；也直接产出报告/落地页/演示/工具（含 `references/` 5 份分支指南） |
| `design-artifact` | 视觉方向：配色、字体搭配、构图、主题、整体调性 |
| `html-wireframe` | 低保真线框，结构/层级/导航还没定的时候 |
| `html-prototype` | 高保真样机或可交互流程 |
| `html-plan` | 计划、路线图、实施顺序、发布方案（可溯源到原文） |
| `html-diagram` | 关系、时序、拓扑、状态、层级、系统行为图 |
| `big-pics-little-words` | 大字少字的图解式说明 |

`html` 是唯一会自动触发的，其余 6 个的 description 里写明了「不要从普通请求独立激活」，正常情况下由 `html` 转过去。

## 斜杠命令（22 个）

`.opencode\commands\` 下每个技能都有一个同名命令，输入就加载，不用模型判断你想干什么。

**设计与动画**

| 命令 | 做什么 |
|---|---|
| `/animate` | 从零写 Web 动画 |
| `/animate-expo` | React Native / Expo 动画 |
| `/animation-performance` | 动画掉帧与性能排查 |
| `/animation-vocabulary` | 动画术语反查 |
| `/apple-design` | Apple 式交互与物理感 |
| `/ask-sonner` | Sonner toast 库用法 |
| `/break-ui` | 用最坏数据压测 UI |
| `/emil-design-eng` | UI 打磨与组件设计 |
| `/find-animation-opportunities` | 找出该加动画的地方 |
| `/improve-animations` | 审计整仓动画并出计划 |
| `/mobile-native` | 让 Web 应用像原生 App |
| `/pick-ui-library` | 选前端 UI 库 |
| `/prototype` | 一次出多个变体供挑选 |
| `/review-animations` | 评审动画代码 |
| `/write-swift` | 现代 Swift / Swift 6 并发 |

**HTML 交付物**

| 命令 | 做什么 |
|---|---|
| `/html` | 总入口，自动路由到下面 6 个 |
| `/design-artifact` | 视觉方向：配色、字体、构图、调性 |
| `/html-wireframe` | 低保真线框 |
| `/html-prototype` | 高保真样机 / 可交互流程 |
| `/html-plan` | 计划与路线图页面 |
| `/html-diagram` | 关系 / 时序 / 状态 / 层级图 |
| `/big-pics-little-words` | 大字少字图解 |

用法：

```
/html-wireframe 帮我出两版订单列表的线框
/html-diagram   画一张支付失败重试的状态流转图
/review-animations src/components/Drawer.tsx
```

不带参数也行，命令会加载技能然后问你要做什么。

## 也可以直接说事

不想记命令时，模型会按 description 自己挑：

- "给这个下拉框加个动画"
- "这个动画掉帧，帮我看看"
- "把这份季度复盘做成一个 HTML 页面"
- "先出两版线框给我挑"

## 关于"仅手动触发"

`pick-ui-library`、`prototype`、`review-animations` 三个技能原本用 `disable-model-invocation: true` 声明只准用户手动调用。**OpenCode 会忽略这个字段**。

现在这三个都有同名命令（`/pick-ui-library`、`/prototype`、`/review-animations`），手动这条路已经通了。剩下的唯一缺口是：模型仍可能自己加载它们。它们的 description 里写了「只在用户明确要求时使用」，一般够用。

要彻底禁止自动加载，在 `opencode.json` 里加：

```jsonc
{
  "permission": {
    "skill": { "prototype": "deny" }
  }
}
```

代价是拒绝后连命令里也加载不了，不建议。

## 与 .dsh 的关系

项目里还有 `.dsh\`（5 个技能 + 9 个命令），那是另一套约定。OpenCode 不读 `.dsh`。两边目前是独立的，需要统一时把 `.dsh` 的内容镜像到 `.opencode\`。
