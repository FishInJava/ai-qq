---
description: 五段过闸：自动检查 / 合规扫描 / 格式化提交 / 创建 PR
---

读 `.dsh/skills/gate/SKILL.md`，严格照它执行。分级、失败处理、什么时候该停下来问人，都写在那份文件里，不要另起一套。

唯一入口是 `node tools/gate.js`，别绕开它去手敲 npm 脚本或 git 命令。

任务：

$ARGUMENTS

如果上面为空，先跑 `node tools/gate.js --fast` 看现在什么状态，把红在哪一条告诉我，别直接动手改。
