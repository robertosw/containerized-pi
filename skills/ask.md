---
name: ask
description: Q&A mode. No file reads, no file changes. Answer from learned knowledge or web search only to avoid context pollution.
---

# Ask Skill

## Rules (enforced until explicit human statement lifts them)

1. Use `web_search` or `web_fetch` to find external information, or answer from internal knowledge — these are the only allowed tool uses.
2. Answer questions, describe solutions, and explain concepts without touching workspace files.
3. If a question genuinely requires file context to answer correctly, **state that** and ask the human to paste the relevant snippet instead of reading it yourself.

## Lifting restrictions

Restrictions stay active until the human explicitly says so (e.g., "you can read files now", "restrictions lifted", "exit ask mode").
