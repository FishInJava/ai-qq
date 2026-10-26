---
name: to-spec
description: |
  把当前对话已经聊过的东西直接合成一份 spec，不做采访式追问，然后发布到本项目的 issue tracker（本地 .scratch/<feature>/spec.md）。
  Use when turning the current conversation into a spec, writing up what was already discussed as a spec, or capturing agreed design as a durable document.
  中文触发：把这个聊的东西整理成 spec、写成规格说明、把刚才的讨论固化成 spec、出个 spec 文档、给我一份 spec。
metadata:
  author: "mattpocock-skills (adapted for DSH)"
  source: "skills/engineering/to-spec/SKILL.md"
  version: "2.0.0-dsh"
---

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user; just synthesize what you already know.

Chat before writing: only if the conversation genuinely contains no agreed direction. If it does, write.

## Where things go

Read `docs/agents/issue-tracker.md` and `docs/agents/domain.md` first.

- Tracker is **local markdown**: the spec lands at `.scratch/<feature-slug>/spec.md`. Create directories as needed (`.` and `..` checks are unnecessary; these paths are inside the workspace).
- If `docs/agents/issue-tracker.md` is missing, create it from the layout section of this file's assumptions before writing, and say so in one line. Do not stop to ask.

## Process

1. **Explore the repo** to understand the current state of the codebase, if you haven't already. Use `GLOSSARY.md` vocabulary throughout the spec, and respect any ADR under `docs/adr/` in the area you're touching. When the project keeps requirements docs (`docs/`, root PRDs), read the relevant one — the spec must not contradict it silently.

2. **Sketch the seams** at which you're going to test the feature. Existing seams are preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase the better — the ideal number is one.

   Show those seams to the user and confirm they match expectations before writing the spec body. One short list, then wait.

3. **Write the spec** using the template below to `.scratch/<feature-slug>/spec.md`, then report the path plus a 3-line summary. Status in the tracker for a fresh spec is `ready-for-agent` — no extra triage pass.

If the user asked for tickets as well, hand off to `to-tickets` rather than inlining a ticket list here.

## Feature slug

2-4 words, kebab-case, from the most meaningful keywords of the feature (e.g. `ai-companion-memory`, `voice-latency-budget`). Reuse the same slug across `spec.md` and `issues/` so the whole feature stays in one folder.

## Template

```markdown
# <Feature name>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories:

1. As an <actor>, I want a <feature>, so that <benefit>

Example: 1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending.

This list should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets — they go stale fast.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

- What makes a good test here (external behaviour only, not implementation details)
- Which modules will be tested
- Prior art for the tests (similar test types already in the codebase)

## Out of Scope

## Further Notes
```

## Quality bar

- Every user story is a real actor wanting a real capability for a real benefit. No "as a developer, I want a spec, so that specs exist".
- Implementation Decisions are decisions, not a task list. If a sentence starts with "first, then", it belongs in tickets.
- Testing Decisions name the seam from step 2 and the existing test file/module that is the prior art.
- Out of Scope is not empty. Name the tempting adjacent thing you deliberately excluded.
- No file paths beyond the seam-level module names, no code snippets beyond the prototype exception.

## Language

Write the spec in the language the user is writing in (this project: 简体中文 术语表混合英文技术词), unless they ask for English.
