# Domain docs

**Layout:** single-context —— 根目录一个 `GLOSSARY.md`，加上根目录 `docs/adr/`。

## Consumer rules

写 spec、写 ticket、实现之前，按这个顺序取上下文：

1. `GLOSSARY.md`（根目录）—— 项目领域词汇的唯一来源。spec 和 ticket 里出现的名词必须用这里的词，不要另造同义词。文件不存在时不要凭空创建一堆术语；等到真有反复出现的领域词需要固定，再按"术语 + 一句话定义 + 反例"的格式追加。
2. `docs/adr/` —— 架构决策记录。动到某块区域前先读该区域相关的 ADR，spec 里写明"遵守 ADR-XXXX"或明确写出要推翻它。
3. `docs/agents/issue-tracker.md` —— 票放在哪、怎么关票。
4. `.specify/memory/constitution.md` —— 若存在，视为项目级硬约束，spec 的 Implementation Decisions 不得与它冲突。

## ADR format

新建 `docs/adr/NNNN-<slug>.md`，编号四位递增：

```markdown
# NNNN: <decision title>

**Status:** proposed | accepted | superseded by NNNN

**Context:** 面对什么约束、为什么现在必须决定。

**Decision:** 决定了什么。

**Consequences:** 因此付出什么代价、放弃哪些选项。
```
