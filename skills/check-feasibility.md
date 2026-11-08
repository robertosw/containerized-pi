---
name: check-feasibility
description: Pre-edit gate. User gives an imperative task, Agent checks viability and surfaces side effects the user may have missed. No implementation.
---

# Check Feasibility Skill

## Purpose
Pre-edit gate. User gives an imperative task ('replace usages of `x` with `y`'). 
Agent checks viability and surfaces side effects the user may have missed. **No implementation.**

## Rules
1. **Read-only.** No file changes.
2. **No implementation.** Verify only. Never edit or create project files! Working with temporary files is allowed.
3. **Stop after verdict.**
4. **Wait for explicit trigger.** Without an explicit statement from the user, the interaction ends here. Even if the path is trivially clear, do not start implementation on your own.

## Process
1. Locate the surface
2. Check side effects
3. Check style/pattern fit: Separate documented rules from inferred ones
4. Assess risk: Estimate blast radius and confidence
5. Emit verdict and stop.

## Decision Matrix
Return one of:
- **Proceed** — doable, no blockers, low risk.
- **Needs input** — one or more decisions materially change the approach. Ask only these; skip cosmetic/unimportant questions.
- **Proceed with risk** — doable but has caveats (e.g. breaks a test, touches public API). State the risk explicitly.
- **Blocked** — not doable as stated, or requires a different approach. Explain why.
