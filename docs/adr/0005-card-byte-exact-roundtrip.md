# 0005: 卡片无损往返 = 原始字节往返

**Status:** accepted

**Context:** T10 的验收是"5 张市面 V2 卡导入字段无丢失，导出与原卡 `extensions` 逐字节一致"。只要实现路径是"解析成对象再序列化回去"，就必然在某些卡上失败：未知字段的顺序、`\u` 转义形式、数字格式（`1.0` vs `1`）、嵌套 `extensions` 里的私有字段、空对象与 `null` 的差别。用户对"我的卡被吃掉"的容忍度是零——这是导入功能的唯一存在理由。

**Decision:**

1. `characters.card_json` 存**原始卡片 JSON 文本**（不是解析后再序列化的对象）；`source_hash = sha256(原始文本)`。
2. JSON 导出：直接吐原始文本字节。
3. PNG 导出：复用原图字节（`characters.card_source_path` 指向导入时保存的原图副本），只把 `tEXt` 中 `chara` 块按原始文本重写 base64（含长度字段与 CRC 重算），其余 chunk 原样保留。
4. 字段映射（`data.*` → 内部结构）是**只读投影**，永不写回原文；V1 卡按六字段读、其余置空、`compat='v1'`。
5. `extensions`、`character_book`、`regex_scripts`、STscript 一律原样保存、不解释、不执行；导入时给一次性提示"脚本已忽略、内容已保留"。
6. 解析失败（无 `chara` 块 / base64 解不开 / JSON 非法 / 超 20MB）→ 中断且不落库，库不变。

**Consequences:**

- 好处：字节级保真可被自动化断言（导出哈希 == 导入哈希）；`extensions` 无论多怪都能原样往返；后续 V1.1 想执行脚本时，原文还在。
- 代价：库里存了两份体积（原文 + 原图），单卡 ≤20MB 上限即为此设；需要额外维护 `card_source_path` 与文件副本清理。
- 代价：不能"顺手修正"卡里的字段——脏数据照样往返，用户看到的就是他给的东西。
- 放弃：统一序列化（`JSON.stringify` 规范化输出）、任何"导出时美化"的选项。
- 影响面：`cards/png.js`、`cards/schema.js`、`store/repo/characters.js`、`http/routes/cards.js`（导出走原始字节流）。
