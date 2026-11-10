# Dart LSP navigation for pi — spec

Symbol-exact code navigation and warm diagnostics for coding agents, backed by one persistent
`dart language-server`. Consumers are agents only. `rg` must remain available and correct for
non-code text (markdown, string literals, comments) and fuzzy pattern searches.

## Environment

- pi runs in a container on a volume-mounted Flutter workspace (sometimes pure Dart). An IDE, if
  present, runs on the host against the same volume. All components run in the container.
- Dart comes from the Flutter SDK (`$FLUTTER_PATH/bin/dart`).
- No npm packages, no vendored code: node side is stdlib-only glue; the logic is from-scratch Dart
  compiled with `dart compile exe`.
- The analysis cache must live on the volume (inside the workspace), not container-local, so
  restarts stay at seconds.

## Requirements

- **Freshness by construction**: every result reflects the on-disk state at query time. No agent
  or human ever makes a freshness/trust decision.
- **Latency**: first answer after cold start within a few seconds; steady state ~tens of ms.
- **No one-shot LSP client.** One daemon is the only path to the language server.

## Architecture

```text
pi process
 └─ extension          6 tools + 2 result hooks; lazy (no daemon until first tool call)
     ▼  one JSON RPC per call (TCP loopback, newline-delimited)
client                rebuild daemon binary if source newer (before every connect);
                      one shared connect-or-spawn per workspace, ping-verified;
                      retry once only after a lost connection
     ▼  stdio, LSP
daemon                per-query freshness gate, diagnostics store, symbol→position,
                      formatting, output limits
     ▼
dart language-server  --cache=<workspace>/.pi/lsp/cache
```

- Daemon transport: TCP on loopback, `<port> <instance token>` + pid in workspace files; requests
  run on a serial queue, `ping` bypasses it.
- Keep-alive: the pi session holds one open connection; the daemon exits after an idle timeout
  without connections (see §Process lifecycle invariants).
- No `kill` of the daemon: pi instances may run in other PID namespaces on the same volume. The
  daemon retires itself when the binary on disk was replaced by a newer build (checked per
  request, `ping` included; it removes its port/pid files only while they still describe itself);
  the client then reconnects or spawns the new binary. Manual stop uses the same path.
- **Build freshness, stamp-based (no hashing)**: the client rebuilds the binary when the newest
  daemon source mtime is newer than the binary mtime. The daemon records the binary's
  `(mtime, size)` at startup and retires if either differs on a later stat of
  `Platform.resolvedExecutable`. A rebuild always writes a new mtime (ns-granular filesystem
  stamps), so `size` only guards against stamp anomalies; hashing the binary per request would be
  I/O for no real safety gain. The container entrypoint copies extensions with `cp -p`, so a
  container start does not bump source mtimes.
- LSP child dies → daemon exits → client respawns and retries once.

## Process lifecycle invariants

These rules keep exactly one language server per workspace and make every failure visible.
A refactor must keep all of them; `test/verify.mjs` guards each one.

1. **One daemon per workspace.** The daemon takes an exclusive kernel file lock on
   `<ws>/.pi/lsp/daemon.lock` before it starts the language server, and holds it until the
   process dies. Without the lock (retried every 200 ms for 10 s) it exits with code 75 and
   starts nothing. Never open the lock file a second time in the daemon process: closing any
   handle drops an fcntl lock.
2. **One connect/spawn per client.** Concurrent calls in one client share a single in-flight
   connect-or-spawn promise per workspace. If the spawned daemon lost the lock (or exited
   cleanly) and no daemon answers, the client spawns again within its 60 s window.
3. **Verified connections.** A client uses a TCP connection only after `ping` returned
   `{workspace, pid, token}` with the token from the port file and its own workspace path.
   Token differs or no answer ⇒ stale port file (SIGKILL, container stop; ports are shared by
   everything on loopback) ⇒ spawn. Token matches but the path differs ⇒ the same directory is
   mounted at another path in another container ⇒ clear error, no spawn.
4. **Ping is never queued.** `ping` bypasses the serial request queue, so a daemon busy with a
   long query is not taken for dead.
5. **Retry only on transport loss.** Error responses and RPC timeouts are returned to the
   caller; they never close a connection or start a daemon. A lost connection is retried
   once: reconnect to a running daemon first, spawn only if none answers. A failing call
   forgets only its own connection entry. A hung daemon is not recovered automatically.
6. **Idle exit.** The daemon exits after `PI_DART_LSP_IDLE_TIMEOUT_S` seconds (default 300)
   with zero open connections, including "never had one". There is no immediate
   exit on the last disconnect.
7. **Ordered shutdown.** Delete own port/pid files → close sockets → `shutdown` request (≤ 2 s)
   + `exit` to the language server → wait ≤ 5 s → SIGKILL → wait → `exit()`. The lock is
   released last, by process death. Worst case (~7 s) stays inside the 10 s lock-retry window of
   a successor.
8. **Atomic rebuild before connect.** The client checks the build before every connect,
   compiles to a uniquely named temp file and renames it over `bin/daemon`. Running daemons keep
   their inode and retire on their next request or ping (binary `(mtime, size)` changed).
9. **Serve only after analysis started.** The daemon listens only after the server's first
   `isAnalyzing: true` (capped at 30 s): before it, `workspace/symbol` answers with an empty list.
10. **Logs survive exit.** One log per daemon instance (`daemon-<startMs>-<pid>.log`), every line
    written synchronously, LSP stderr and exit code included, ≤ 10000 lines (trim to the newest
    9000), files older than 7 days deleted at extension startup.

## Freshness

Two layers:

1. **Hook (optimization)**: on `write`/`edit` of a `.dart` file the extension pushes the path;
   the daemon sends `didChange` immediately so analysis runs between queries.
2. **Gate (guarantee)**, before every query:
   - Walk the workspace (skip hidden dirs, `build`, `node_modules`, platform dirs), stat every
     `.dart` file, diff `(mtime, size)` against the index → new / changed / deleted.
   - Sync each difference: `didOpen` (full text) if not open, `didChange` (full text) if open;
     deletion → `didClose`, or `didOpen('')` + `didClose` if never opened (re-reads disk).
   - Navigation queries then go straight to the server: it processes messages in order and
     applies pending changes before answering. **Navigation never waits for analysis.**
   - `diagnose`/`fix` additionally wait for settled analysis (§barrier), capped with a warning.

**Unconfirmed set**: Linux mtime granularity is ~1 ms (the kernel stamps files from a coarse
clock; back-to-back writes share the same timestamp), so `(mtime, size)` can miss a same-size
edit within one tick. A file read from disk by the gate less than 1 s after its mtime enters an
unconfirmed set ("read" means the daemon's own disk read — it cannot observe the agent's read
tool); the gate re-reads and content-compares those. A file leaves the set once read from disk ≥ 1 s
after its mtime.

**Priority files**: the server caches resolved units only for open files; unopened files
re-resolve per request. `didOpen` every file a query touches and keep it open.

**Baseline order**: index the disk *before* starting the server, so any later edit gets a newer
stamp.

## Settled analysis (for `diagnose`/`fix`)

- The only signal is the `$/analyzerStatus {isAnalyzing}` notification (it is sent because the
  client declares no `window/workDoneProgress`). There is no pull-diagnostics method.
- `isAnalyzing: true` appears only ~25–50 ms after a change; "idle" right after sending means
  nothing. The status flaps during startup and on no-op edits.
- **Barrier**: after sending changes, request `textDocument/hover` on one changed file. The
  server can only answer after analyzing that file, and it sends `isAnalyzing: true` before the
  answer; the next `isAnalyzing: false` ends the wave caused by our changes.
- The barrier is owed for *any* change sent since the last wait — including changes sent by the
  hook or by an earlier navigation query.
- Deletion-only changes leave no file to put the barrier on: accept a timing fallback (wait for
  `true`, then `false`, short cap); `diagnose` can return pre-deletion diagnostics in that case.

**Diagnostics coverage**: the server pushes diagnostics only for *open* files, so a `diagnose`
request must `didOpen` every file in its scope (the `files` argument, or every `.dart` file in the
workspace when omitted) and keep them open. The first workspace-wide scan pays a one-time
full-analysis wave (capped; may return a partial result with a warning). Afterwards the store stays
fully populated and scans are cheap — they only wait for the incremental wave after changes. Cost
of the opened set: server memory for resolved units, bounded by the workspace.

## LSP protocol facts (measured against the Flutter SDK's `dart language-server`)

- `initialize` params field is `capabilities` (not `clientCapabilities`).
- Declare: hierarchical document symbol support, code action literal + data + resolve
  (`properties: [edit]`) support.
- `textDocument/references` requires `context: {includeDeclaration}`.
- Type hierarchy: `textDocument/prepareTypeHierarchy`, then `typeHierarchy/subtypes|supertypes`
  with `{item}`. The Dart-specific `dart/textDocument/super` gives the member override chain.
- Server→client requests must be answered: `workspace/configuration` → one `{}` per item (one
  per workspace folder + one global), `workspace/applyEdit` → `{applied: false}`, others `null`.
- `didChange` without a prior `didOpen` kills the server (exit 0).
- Right after `initialized`, `workspace/symbol` answers with an empty list until the first
  `$/analyzerStatus {isAnalyzing: true}` (~0.35 s warm cache, ~4 s empty cache); requests sent
  after it are held until results are ready.
- `-32007` "File is not being analyzed" right after open → retry with delay, bounded.
- `prepareTypeHierarchy` at a use site in *another* file returns the item with ranges computed
  from the requesting file's line table (sub/supertypes are correct). Workaround: `definition`
  first, then prepare at the declaration itself.
- `workspace/symbol` `location.range` spans the whole declaration starting at its doc comment;
  positions inside it resolve to nothing. Use the `documentSymbol` entry with that name whose
  `selectionRange` lies inside the workspace-symbol range as the position.
- `documentSymbol`/`definition` results carry no documentation: slice doc comments from disk.
- References to a class include its constructor invocations.
- `dart/workspace/analysis/complete` does not exist.
- The server watches the filesystem itself, but asynchronously (races a query right after an
  edit) and it does not apply to open documents (overlays win). The gate is still required.

## Tool contract

Commons: `file` may be a repo-relative, absolute, or unique-suffix path. `symbol` + optional
`file` + optional `line`.

| Tool | Behavior |
|---|---|
| `references {symbol, file?, line?, includeExternal?}` | All use sites (calls, field read/write, pattern matches, event-bus dispatch/listen pairs), grouped by file (path printed once, then `line: source`), sorted. |
| `definition {symbol, file?, line?}` | Doc comment + declaration. Declarations above ~80 lines: header + member signatures. |
| `outline {file}` | `documentSymbol` tree: signatures + up to 3 doc-comment lines per node, no bodies. |
| `hierarchy {symbol, file?, line?, depth?, includeExternal?}` | Type: supertype chain (always complete, external included) + subtype tree (`depth`, default 2; sealed ⇒ complete) + its references (exhaustive-switch blast radius). Member (method/getter/setter/field): members it overrides (super chain), members overriding it (implementation, all levels), its references. Detection: `prepareTypeHierarchy` at a member returns the enclosing class, so "type" = prepared item's name sits on the requested line. |
| `diagnose {files?, includeInfos?}` | Errors + warnings; infos/hints only with `includeInfos` (and then not mentioned as hidden). Like `flutter analyze`. |
| `fix {file, line, symbol?, pick?}` | Quick fixes for the diagnostics on the line. Without `pick`: numbered list. With `pick`: the edit as oldText/newText hunks — whole lines, widened until `oldText` is unique in the file. **Never auto-applied**; the agent applies it with `edit` (which fires the hook). Command-only actions: run `workspace/executeCommand`, capture the `applyEdit` the server sends, answer `applied: false`, return the captured edit. |

**Output budget** (agent context): `references` 50 entries; `hierarchy` 30 subtypes/overrides +
50 references; hits outside the workspace (pub cache, SDK) only with `includeExternal`. A cut
list ends with a marker naming a temp file holding the complete result and the line where the
omitted part starts; temp files older than a day are deleted when the next one is written.

**Symbol → position**:
- `file` given: scan for the identifier, skipping comments/imports/strings; prefer occurrences
  preceded by a declaration keyword (`class`, `mixin`, `enum`, `extension`, `typedef`, `type`).
  Occurrences resolving to the same declaration are not ambiguous (a constructor nested in its
  class counts as the class). Truly different targets → numbered candidate list; the agent
  passes `line`.
- `line` is a hint only: if the symbol is not on that line, search the whole file.
- `file` omitted: `workspace/symbol` exact-name match, position per the §facts above.

## Prompt integration

- Each tool sets a one-line `promptSnippet` (custom tools are missing from pi's tool list
  without it) and `promptGuidelines` rules bullets.
- Guidelines must map **questions to tools** ("who uses X → `references`", "what extends X →
  `hierarchy`", …) and say `diagnose`/`fix` replace `flutter analyze` while editing. Abstract
  "prefer these tools" wording loses against bash with small models; question-specific mappings
  work.
- **Bash tip hook**: a bash search that hit Dart code (text search with a camel/PascalCase
  identifier in the command, or file search, with `.dart` in the output) gets one line appended:
  use the Dart tools. Text searches without identifiers stay quiet. A hint next to the result
  outperforms a rule read many turns earlier.
- **Write/edit hook** → daemon sync (the hook is optimization only; the gate is the guarantee).

## Non-decisions

- No `bash` sync hook (most bash calls touch no files; the gate reads disk anyway).
- No background polling, no raw-LSP / debug / respawn tools, no auto-applied fixes.
- Do not make the hook the freshness guarantee. Do not trust `isAnalyzing: false` without the
  barrier; no wall-clock settle windows.
- No `flutter analyze` in bash as the default feedback loop.

## Verification

A test script (node, same client as pi, edits real tracked files, restores them in `finally`,
fails on `git status` diff):

- Latency phases: cold start; steady state (queries after a settle); churn (edits + hook per
  turn); heavy churn (multiple edits per turn, no hook).
- Freshness, no hook (out-of-band editor twin): append a sealed subclass → `hierarchy` lists it,
  `diagnose` flags non-exhaustive switches; restore → both gone.
- Freshness, forged: rewrite with identical size and mtime → still detected.
- Freshness, lifecycle: new file and deletion via plain fs → `references` include / drop it;
  diagnostics of a deleted file are cleared.
- Freshness, ordering: repeated edit + hook sync + immediate `diagnose` → never stale.
- `diagnose` output matches real `flutter analyze` (same issues, same locations).
- LSP child crash → transparent respawn, one retry.
- Process lifecycle: one daemon + one LSP under parallel calls (one of them an error) and two
  concurrent clients; lock loser exits 75 without LSP; retire handover leaves no orphan LSP; idle
  exit with and without a prior connection; stale port file; ping answered while the queue is
  blocked; respawn after a lost lock; same directory under another path → clear error; shutdown
  reason and LSP exit code in the log.
