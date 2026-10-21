---
name: feedback-plan-execution-workflow
description: "Turgay's preferred cycle for multi-plan projects — brainstorm, spec, plan, inline TDD execution, fresh-review, single fix pass, commit directly on master"
metadata:
  type: feedback
---

For substantial multi-plan projects:

- **Brainstorm → written spec → written plan** with explicit approval gate at each stage before implementation.
- **Native/inline execution** — single session implements every task with TDD, no per-task subagent reviewer.
- **No git worktree** — work directly on master, no feature branches.
- **One fresh-context final review per plan** via Agent tool on opus model after all tasks done.
- **One fix pass**: Critical+Important findings fixed with RED→GREEN test verification; Minors deferred and reported.
- **Empirical pre-verification** of tricky logic before writing into the plan (bash probes, regex checks).

**Why:** Spend review budget on the one truly independent pass (final review); trust plan + TDD discipline for the rest.

**How to apply:** For any future multi-plan project, propose this exact cycle by default. Only deviate if asked.
