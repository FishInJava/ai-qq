---
name: implement-spec
description: |
  按 spec 和它的 tickets 把功能真正写进代码：tickets 是任务图，按 frontier 并行派实现子代理，最后 code review + 关票。
  Use when implementing a spec, working through a ticket graph, executing the tickets produced by to-tickets, or finishing a feature end to end.
  中文触发：按 spec 实现、把这个 spec 落地、开始实现这些票、照 ticket 图干活、把 spec 写完。
metadata:
  author: "mattpocock-skills (adapted for DSH)"
  source: "skills/engineering/implement-spec/SKILL.md"
  version: "2.0.0-dsh"
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement it.

Read `docs/agents/issue-tracker.md` and `docs/agents/domain.md` first. If neither the spec nor tickets exist, stop and say which one is missing — do not invent scope.

The goal is the entire spec implemented, with every ticket resolved the way the local tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec path, ticket paths, research notes, and previous commit hashes. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency (`subagent` with `run_in_background: true`).

## Steps

1. Read `.scratch/<feature-slug>/spec.md` and every file in `.scratch/<feature-slug>/issues/` to understand the task graph. Build the frontier: tickets whose blockers are all `done`.

2. (optional) Use an **exploration subagent** for any exploration the tickets require — relevant codebase files or external documentation. It should save markdown notes to `.scratch/<feature-slug>/notes/`, outside the implementation surface, so implementers can read them by pointer. This lets **implementer subagents** focus on implementation rather than exploration.

3. Establish the integration surface.

   - **Repo has git:** create the integration branch off the current main line. If the tracker closes work through PRs, or the user asks for one, open a draft PR after the first merge in step 5 (a branch with no commits ahead can't open one), marked as closing the spec and tickets.
   - **No git repo (this project's default):** there is no branch or worktree. Declare the integration surface as the working tree itself and start by copying the touched files (or the whole feature surface) into `.scratch/<feature-slug>/rollback/` so a broken implementation can be reverted. Parallel implementers then **must not touch the same file** — give each frontier ticket an explicit file ownership list before dispatch, and serialize any tickets that share a file.

4. Use **implementer subagents** to implement each frontier ticket, one subagent per ticket. Each implementer subagent:

   - confirms it is working on the integration surface (correct branch, or the declared working tree) before starting, and resets onto it if not;
   - loads the `tdd` skill if it is available, and builds the ticket test-first — red, green, refactor. If `tdd` is not installed, follow the same loop inline: write the failing test at the seam from the spec's Testing Decisions, make it pass, then refactor;
   - stays inside its stated file ownership;
   - before reporting done, merges the integration branch tip into its own branch (git case) or re-reads the shared files it depends on to confirm no drift (no-git case), and runs the ticket's acceptance checks;
   - reports back only: ticket number, files touched, test command + result, anything the ticket asked for that it could not do.

5. Once an implementer completes, merge its work to the integration surface. In the git case, use a **merger subagent** for the merge; in the no-git case, review the diff yourself and fix conflicts before accepting.

6. If this changes the **frontier**, kick off more **implementer subagents** for the newly unblocked tickets. This is where concurrency pays off.

7. Once all tickets are complete, run a code review over the whole feature diff. Load the `code-review` skill if available; otherwise review on two axes — Standards (does it follow this repo's documented conventions) and Spec (does every acceptance criterion hold, and does anything exceed the spec's scope). Fix all issues raised in a single **implementer subagent**.

8. Close the work: for each ticket, check the acceptance boxes, set `**Status:** done`, and append `## Notes` describing what actually landed and any deviation from the spec. Update `spec.md` only where implementation genuinely changed a decision, and mark the change so the spec stays truthful.

9. If a draft PR exists, mark it ready for review. Otherwise report the integration surface: which tickets are done, where the rollback copies live, and how to run the tests.

10. Clean up: remove **implementer subagent** worktrees (git case), and delete `.scratch/<feature-slug>/rollback/` only after the user confirms the result.

## Hard rules

- One ticket at a time per subagent. No ticket spanning two subagents.
- Never close a ticket whose acceptance criteria you did not verify by running something.
- Never modify a ticket's scope to match what got built. If the implementation drifted, either fix the code or say the ticket is not done.
- Tests assert external behaviour at the spec's seam. No assertions on private helpers.
