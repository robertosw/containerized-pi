# pi-dart-lsp

Dart LSP navigation and warm diagnostics for the pi coding agent. One persistent
`dart language-server` behind one small daemon; the agent gets symbol-exact
`references` / `definition` / `outline` / `hierarchy` / `diagnose` / `fix` tools that
always reflect on-disk state. Full design: [`docs/pi-dart-lsp-idea.md`](../../docs/pi-dart-lsp-idea.md).

## Why implement this manually?

- **Smaller attack surface**: fewer packages, less supply-chain — stdlib node glue plus one
  self-contained Dart program, no npm dependencies at all.
- **Existing LSP extensions didn't work reliably** for this use (persistent server, warm cache,
  agent-only consumers, sub-second answers).
- **To try it** — and to optimize for speed, which paid off: ~7 s cold start, ~20 ms steady state.

**Should you use it?** Probably not. Vibe coded to a strong extend. Not yet tested across multiple
dart / flutter sdk versions.

## Architecture

```text
pi process
 └─ extension/          6 dart_* tools + 2 result hooks; lazy (no daemon until first call)
     ▼  one JSON-RPC per call (TCP loopback, newline-delimited; port+pid in <ws>/.pi/lsp)
client/                 node, stdlib-only glue: rebuilds the binary if daemon sources are
                        newer (mtime), shares one connect-or-spawn per workspace, verifies
                        the daemon via ping, retries once only after a lost connection
     ▼  stdio, LSP
daemon/                 dart compile exe. Per-query freshness gate, diagnostics store,
                        symbol→position resolution, settled-analysis barrier, output limits
     ▼
dart language-server    --cache=<ws>/.pi/lsp/cache   (cache on the volume, not container-local)
```

- Daemon requests run on a serial queue (`ping` bypasses it); the LSP child dies ⇒ daemon
  exits ⇒ client respawns and retries the call once. No daemon `kill` path; the daemon
  retires itself when its on-disk binary is replaced (checked per request), keeping pid/port
  file hygiene across PID namespaces.
- **One daemon per workspace**: the daemon takes an exclusive kernel lock on
  `<ws>/.pi/lsp/daemon.lock` before it starts the language server. A daemon that cannot get
  it within 10 s exits (code 75) without starting one. The kernel releases the lock on
  process death — no stale locks, works across PID namespaces.
- **Client**: concurrent calls share one connect/spawn per workspace. A new connection is
  used only after `ping` returns the instance token from the port file (else the port file
  is stale) and this workspace path. Error responses (e.g. "file not found") and timeouts go
  straight to the tool. Only a lost connection reconnects (running daemon first) or spawns,
  then retries once. If a spawned daemon lost the lock and the holder is gone, the client
  spawns again (within 60 s).
- **Same directory, different mount path** (e.g. one container mounted the git root, another
  only the project): the second pi gets a clear error instead of a second daemon. Start every
  pi on a workspace with the same mount choice.
- **Idle exit**: the daemon exits after `PI_DART_LSP_IDLE_TIMEOUT_S` seconds (default 300)
  without any open connection — also when it never had one. pi keeps one connection open
  for the whole session.
- **Rebuild** runs before every connect, compiles to `bin/daemon.tmp-<pid>-<random>` and
  renames it over `bin/daemon` (never writes over the running binary). A daemon running an
  older binary retires on the client's `ping`.
- **Startup**: the daemon listens only after the language server reported its first
  analysis (capped at 30 s); before that, `workspace/symbol` answers with an empty list.

## Freshness (no staleness decisions by agents or humans)

- **Hook** (optimization): pi's `write`/`edit` of a `.dart` file pushes the path; the
  daemon sends `didChange` immediately.
- **Gate** (guarantee): before every query the daemon stats every `.dart` file in the
  workspace, diffs `(mtime, size)` against its index, and syncs
  `didOpen`/`didChange`/`didClose` for all differences. A "unconfirmed set" re-reads and
  content-compares files whose gate read happened <1 s after their mtime (same-tick
  same-size writes are caught this way).
- **Barrier** (for `diagnose`/`fix`): waits for a settled `$/analyzerStatus` wave via a
  throwaway hover on a changed file, capped with a warning.

## Lifecycle

| Event | Behavior |
|---|---|
| First tool call | client builds (if needed) + spawns daemon; daemon takes the lock, indexes disk, starts LSP child |
| Concurrent calls / second pi session | share the one running daemon (in-flight connect dedup + lock) |
| Error response / timeout | returned to the tool; connection and daemon untouched |
| Source edited | next connect rebuilds (temp + rename); old daemon retires on its next request or ping; new daemon waits ≤ 10 s for the lock; client retries once |
| LSP child dies | daemon exits; client reconnects or respawns and retries the call once |
| No connection for `PI_DART_LSP_IDLE_TIMEOUT_S` (300 s) | daemon exits |
| Daemon exits (any reason) | stops the LSP child (`shutdown` + `exit`, ≤ 5 s, then SIGKILL) and waits for it; lock released last |
| Daemon hangs | no automatic recovery: `pkill -f .pi/lsp/bin/daemon`; the next call starts a new one |
| Restart | warm: cache on volume ⇒ first answer in seconds (measured ~7 s cold, ~20 ms steady) |

## Logs

- One file per daemon instance: `<ws>/.pi/lsp/daemon-<startMs>-<pid>.log` (the start time
  keeps names unique across containers).
- Line format: `<ISO-8601 timestamp> [daemon|lsp] <message>`. `[lsp]` lines are the
  language server's stderr; `[daemon]` lines cover start, lock acquired / held, listening
  port, connection open / close, shutdown reason and the LSP exit code.
- Every line is written synchronously, so the shutdown reason survives `exit()`.
- At most 10000 lines per file; on reaching it the oldest lines are dropped (rewrite to the
  newest 9000).
- The extension deletes log files (and leftover `bin/daemon.tmp-*` of interrupted builds)
  not modified for 7 days at startup.

## Verification

`node test/verify.mjs` — 29 checks: cold/steady/churn latency, out-of-band twin edits,
forged same-size same-mtime rewrites, file lifecycle, edit+hook ordering, parity with
real `flutter analyze`, LSP child crash + transparent respawn, single daemon under
parallel calls and two clients, lock loser, retire handover without orphan LSP, idle
exit (never connected / after disconnect), stale port file, ping while the queue is
blocked, respawn after a lost lock, same directory under another path, log content, git
tree pristine after restore. **Run it after any Flutter/Dart upgrade** (see below).

## Version reference

Built and verified against **Flutter 3.38.5 / Dart 3.10.4** (stable, 2025-12).

Version coupling is thin — the daemon speaks plain LSP — but these spots are the
measured, server-version-sensitive parts and are what the test suite guards:

- `workspace/applyEdit` is gated by the **legacy `workspace.applyEdit`** capability key
  (not `workspaceEdit.apply`); `dart.edit.codeAction.apply` and its argument shape.
- `$/analyzerStatus` as the settled-analysis signal; `-32007` retry right after open;
  the whole-file quickfix command names filtered out of `fix` results.
- Right after `initialized`, `workspace/symbol` answers with an empty list until the server's
  first `isAnalyzing: true`; the daemon waits for it before it listens.
- `shutdown` request + `exit` notification ends the server with exit code 0.
- The analysis cache format: after an SDK upgrade the old `.pi/lsp/cache` may be
  incompatible — if cold start breaks, delete `<ws>/.pi/lsp/cache`.
