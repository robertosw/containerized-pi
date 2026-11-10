# Flutter / Dart Analyze Shim — Design

## Goal

Static analysis runs only through the `dart_diagnose` tool of the pi-dart-lsp
extension (`extensions/pi-dart-lsp`). That tool is warm (~20 ms steady state) and
always reflects on-disk state. The shims stop the agent from using
`flutter analyze` / `dart analyze` in bash and point it to `dart_diagnose`.

The shims do not run diagnostics themselves. `dart_diagnose` lives in the pi
process; a shell script cannot call it.

## Mechanism

PATH shims intercept `flutter` and `dart`. The entrypoint puts
`/usr/local/share/pi/shims` ahead of the real SDK at `$FLUTTER_PATH/bin`. Real
binaries are called by absolute path to avoid recursion.

The Dockerfile copies `shims/` into the image and runs `chmod +x`.

The pi-dart-lsp daemon, its client, and `test/verify.mjs` call
`$FLUTTER_PATH/bin/dart` / `$FLUTTER_PATH/bin/flutter` by absolute path, so the
shims do not affect them.

## `flutter` shim

- Subcommand == `analyze` → print one line and `exit 100`:
  ```
  Not available in shell. Use the dart_diagnose tool instead (files: [...], or omit for the whole workspace).
  ```
  All args are ignored. Exit code `100` is distinct from flutter's `0` (clean) and
  `1` (issues), so the agent never reads it as an analysis result.
- All other subcommands → transparent passthrough (`build`, `run`, `test`, `pub`, …).

## `dart` shim

- Subcommand == `analyze` → `exec` the `flutter` shim in the same dir, so both
  print the same message.
- All other subcommands → transparent passthrough to real `dart`.

## Behavior summary

| Invocation                          | Result |
| ----------------------------------- | ------ |
| `flutter analyze [args]`            | message pointing to `dart_diagnose`, exit 100 |
| `dart analyze [args]`               | same as `flutter analyze` |
| `flutter <other>` / `dart <other>`  | passthrough |

## Risks / edge cases

- The shims apply to every shell in the container, not only the agent's. Use
  `$FLUTTER_PATH/bin/flutter analyze` to run the real analyzer.
- A shim bug breaks the SDK globally. Keep each shim tiny; test `build`, `run`,
  `test`, `pub` passthrough.
- Depends on the shims dir staying ahead of `$FLUTTER_PATH/bin` in `PATH` and on
  `$FLUTTER_PATH` being set (set by compose).
