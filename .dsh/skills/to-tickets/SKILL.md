---
name: to-tickets
description: |
  把一份 plan、spec 或当前对话拆成 tracer-bullet 票（垂直切片），每张票声明自己的 blocking edges，发布到本项目本地 tracker（.scratch/<feature>/issues/NN-slug.md，依赖关系写成文字）。
  Use when breaking a spec or plan into tickets, slicing work into verifiable vertical slices, or planning an implementation order with blocking dependencies.
  中文触发：把 spec 拆成票、拆任务、出 ticket、按依赖排个实现顺序、拆成能独立验证的小块。
metadata:
  author: "mattpocock-skills (adapted for DSH)"
  source: "skills/engineering/to-tickets/SKILL.md"
  version: "2.0.0-dsh"
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it.

## Where things go

Read `docs/agents/issue-tracker.md` and `docs/agents/domain.md` first. Tracker is **local markdown**:

- one file per ticket: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- numbered from `01` in dependency order (blockers first)
- "Blocked by" names the numbers/titles it depends on
- status line starts at `ready-for-agent`

Never write one combined tickets file.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, a feature slug) as an argument, read `.scratch/<feature-slug>/spec.md` in full before slicing. If no spec exists and the conversation is thin, say what's missing and stop — tickets invented from nothing are waste.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state. Ticket titles and descriptions use `GLOSSARY.md` vocabulary and respect ADRs in the area you're touching.

Look for prefactoring opportunities that make implementation easier. "Make the change easy, then make the easy change." Prefactoring tickets come first and block the slices they enable.

### 3. Draft vertical slices

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate call sites in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping the build green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any be merged or split further?

Iterate until the user approves. Do not write files before approval.

### 5. Publish

Write the approved tickets under `.scratch/<feature-slug>/issues/`, dependency order, using the template below. Then report the folder and the frontier (which tickets have no open blockers).

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT modify `spec.md` while publishing tickets; if the slicing exposed a hole in the spec, say so and let the user decide.

## Template

```markdown
# <NN>: <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective, not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None (can start immediately)".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype.

## Language

写中文，除非用户要求英文。
