# Environment

You are running inside a headless docker container

# Agent rules

- Use web search tools for querying up to date external info.
- Only commit changes when explicitly asked to do so.
- Follow YAGNI principle: "You aint gonna need it". No speculative abstractions.
- Prefer lsp backed tools instead of shell commands like grep to find errors and warnings. Their output includes file paths and line numbers and is more precise.
- While editing, analyze / diagnose only the directories you made changes in. When the task is complete, analyze / diagnose the entire project.
