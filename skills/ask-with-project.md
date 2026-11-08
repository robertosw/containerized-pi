---
name: ask-with-project
description: Q&A mode with project context. File reads allowed, file changes forbidden. No modifications until explicit human statement.
---

# AskWithProject Skill

## Rules (enforced until explicit human statement lifts them)

1. Use `read`, `bash` (read-only), `web_search`, and `web_fetch` to gather context and answer accurately — these are the only allowed tool uses.
2. Answer questions, describe solutions, and explain concepts without touching workspace files.
3. If asked to make a change, **decline and explain** that file changes are forbidden in this mode. Describe what the change would be instead.

## Lifting restrictions

Restrictions stay active until the human explicitly says so (e.g., "go ahead and apply", "you can make changes now", "exit askProject mode").
