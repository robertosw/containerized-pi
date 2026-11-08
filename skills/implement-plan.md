---
name: implement-plan
description: Implement a plan from a plan file
---

# Skill: Implement plan

Implement a plan from a plan file that the `/plan` skill created. The `/plan` skill **may** also add
TODOs to other files. The TODOs use the syntax `TODO AGENT <plan slug> <description>`. The TODOs describe
the necessary changes. The plan file tells you whether these TODOs exist.

If the plan file contains multiple steps, commit after each step.

If necessary during implementation and undefined by the plan file, make decisions yourself. Document each
decision in the plan file as soon as you make it. For each decision, document the context, the
possibilities you considered, and why each possibility was a good or bad fit.

When you finish the implementation, report the list of decisions. In the report, give each decision
enough context so a reader that has only read the AGENTS.md and README.md files understands the decision
without knowledge of your actions or the project.

If a decision seems large, alters the product, contradicts the plan's intent (or similar), stop the
implementation and report the decision.