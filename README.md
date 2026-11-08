# containerized-pi

My personal setup to run the [pi coding agent](https://pi.dev) inside a Podman container, together with the
extensions, skills, and system prompt rules I use every day.

This repo is shared as inspiration, not as a ready-to-use product. Paths, providers, and rules fit my machine and
my workflow. Take what is useful and adapt it.

Branches: `main` contains the containerization. `flutter` builds on it and adds Flutter / Dart tooling.

# Overview

| Part | Purpose |
|---|---|
| [`pi`](pi) | Host launcher, deliberately without `.sh`: symlinked as `pi`, it feels like a native install. Mounts the current directory (or, after a prompt, the enclosing git repo) and starts the container. Mount rules are in the script comments. |
| [`Dockerfile`](Dockerfile), [`compose.yaml`](compose.yaml) | Image: Node LTS, pi, and the assets of this repo. |
| [`entrypoint.sh`](entrypoint.sh) | Runs on every container start: copies the assets into the persistent volume, installs / updates pi packages, sets env vars (Tavily key, my local llama.cpp server). |
| [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) | My rules, appended to the pi system prompt. |
| [`keybindings.json`](keybindings.json) | `Enter` = new line, `Alt+Enter` = submit. |
| [`web-search.json`](web-search.json) | Provider routing for `pi-web-access`: Tavily first, Exa as fallback. |
| [`docs/`](docs) | Specs: [container behavior](docs/behavior-spec-sheet.md), [UI extension constraints](docs/SPEC-ui-extension.md). |

## Extensions
- [`ui-extension.ts`](extensions/ui-extension.ts): replaces editor and footer with one bordered box (model, git branch, token / cost / context stats).
- [`cost-tracker.ts`](extensions/cost-tracker.ts): records the cost of each message; `/cost` shows the totals.
- [`prompt-duration.ts`](extensions/prompt-duration.ts): measures the duration of each prompt.
- [`tokstats/`](extensions/tokstats/index.ts): `/tokstats` shows tok/s and token totals per model.
- [`load-files/`](extensions/load-files/index.ts): `/load-files <@paths...>` puts full file contents into the context.
- [`answer-plan/`](extensions/answer-plan/index.ts): `/answer` asks the questions of the last `plan` turn one by one.
- [`lib/`](extensions/lib): shared helpers and tests. Not loaded as an extension.

## Skills
- [`ask`](skills/ask.md) / [`ask-with-project`](skills/ask-with-project.md): Q&A without file changes.
- [`check-feasibility`](skills/check-feasibility.md): checks a task and shows side effects before any edit.
- [`plan`](skills/plan.md) / [`implement-plan`](skills/implement-plan.md): interview, then TODOs in code plus a plan file, then implementation.
- [`lint`](skills/lint.md): my Dart class conventions.
- [`ste100`](skills/ste100.md): explain or rewrite in ASD-STE100 Simplified Technical English.

# Setup
1. Create a symlink `/usr/local/bin/pi` that points to this executable [`pi`](pi): 
   ```shell
   ln -s /home/user/containerized-pi/pi /usr/local/bin/pi
   ```
2. Make it executable `chmod +x /usr/local/bin/pi`
3. Build the image: `podman compose build`
4. Execute `pi` anywhere as if it were natively installed
5. Optional, web search: get an API key at [tavily.com](https://tavily.com), start pi and store the key:
   ```shell
   !! echo "api key" > /root/.pi/agent/tavily_api_key
   ```

# Security notes
- The agent sees only the mounted directory and the named volume `pi-agent-home` (pi config, sessions, API keys).
- The agent cannot push to a remote only because the container has no credentials (SSH keys, tokens). Nothing else
  prevents it.
- The container runs with `--network host`. It shares the network stack of the host and can reach all services on the
  host's `localhost` and on the LAN. There is no network isolation. That's a bit lazy, but was necessary for debugging once and I just kept it.

# Updating
- System prompt rules: edit [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md), then `podman compose build`.
  The same applies to extensions, skills, and config files: they are part of the image and are copied into the
  volume on every start.
- pi itself: `podman compose build --no-cache`.
- pi packages: [`entrypoint.sh`](entrypoint.sh) installs / updates them on every start.
