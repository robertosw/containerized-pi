---
name: plan
description: Interview to lock requirements and design decisions, then place scoped TODOs at exact code locations plus a plan markdown holding cross-file flow and constraints, enabling implementation without external context.
---

# Plan Skill

Plan slug: `<MMDD>-<word>` (e.g. `0613-login`). Used as filename `0613-login.md` and as TODO prefix.

All numbered lists use sequential markdown numbering (`1.`, `2.`).

## Phase 1: Interview (MANDATORY)

Interview eagerly until you and the user agree on the requirements and the program design. Iterate in
chat. Do not write the plan body or TODOs until the completion gate passes. Phase 1 locks decisions;
Phase 2 converts them into TODOs and the plan body.

- Never assume a default. Any unspecified choice is a question.
- When the user answers or confirms a choice, record it as an assumption in the plan file.
- Approved assumptions live in the plan file only. Do not show them in chat.
- You may create the plan file early to hold the assumptions ledger. Do not add TODOs or implementation
  details until Phase 2.
- Keep asking about any unspecified choice until all questions are answered.

### Validate prompt logic

- Challenge only material contradictions, impossible constraints, and unverified plan-changing claims.
- State: claim, concern, impact, resolving question.
- Repo evidence conflicts: hard = blocker; soft = question (which may become an approved assumption).
- Proceed only after material issues are resolved (approved assumption or user instruction).
- Probe: problem, why, constraints, components, integration, edge cases, testing, success criteria, and
  what must NOT change.

### Question depth

Scale each question to its complexity. You decide the depth.

- Simple question: one or two sentences. No options.
- Complex question:
  1. Question.
  2. Context — why it matters and what depends on the answer.
  3. Options with trade-offs. Match the question's level: user-flow questions stay at user level;
     architecture or design questions may use implementation-level options.
  4. Recommendation — marked clearly, with a grounded reason. Keep the reason brief when the gap between
     options is clear. Expand it when options differ in small details with large impact.

Options close questions. Approved choices go into the assumptions ledger. Options are not plan output.

### Each turn

Use exactly one section: `## Questions`.

- Header exactly `## Questions`.
- Open questions only. Do not reprint answered questions.
- Sort questions by importance. Blockers first.
- Max 3 per turn.
- Soft tiers (no strict rank): blocks the plan / impact likely / impact unlikely.

**Re-surface each turn:**

1. Changelog — plan-body changes since last turn (scope, files, logic). Exclude assumption changes. If
   there are none, say so.
2. Open `## Questions`.

Do not print the assumptions ledger in chat.

**Completion gate — Phase 2 only when:** all questions are answered.

## Phase 2: Write TODOs + plan markdown

1. TODO syntax: `TODO AGENT <plan slug> <description>`. Stable prefix. The agent fills the description.
2. Confirm all files to modify, create, or delete. Stub files now if a TODO needs a non-existent file.
3. Place each TODO at the exact code location it concerns.
4. Scope each TODO to its file, class, or method only. Do not put whole-flow narrative in a single-step
   TODO.
5. Plan markdown holds all non-implementation info that does not belong in a TODO: cross-file flow,
   sequence, semantics, constraints, and the assumptions ledger. List touched paths. State TODO names so
   a reader can grep them. Place it at the deepest common ancestor of touched files; fall back to the
   current working directory.
6. Add only TODOs, stubs, and markdown. Do not add real implementation.
7. Confirm creation to the user.

The assumptions ledger lists all approved assumptions and any superseded assumptions. The implementing
model reads this ledger so it does not re-derive them.
