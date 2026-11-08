# UI Extension Suite — Spec Sheet & Constraints

Authoritative constraints for refining `ui-extension.ts` + sibling extensions.
Read before editing. Violating any **MUST** breaks load or render.

---

## 1. File layout & loader rules

```
extensions/
  ui-extension.ts        # real extension (default factory)
  cost-tracker.ts        # real extension (default factory)
  prompt-duration.ts     # real extension (default factory)
  lib/                   # NOT auto-loaded (no index.ts / package.json)
    ui-lib.ts            # pure helpers + BoxWidget
    cost-lib.ts          # cost storage singleton
    duration-lib.ts      # timer singleton
    ui-lib.test.ts       # node:test unit tests
```

- **MUST:** pi auto-loads every top-level `extensions/*.ts` and requires a
  `export default function (pi)` factory. Files without it fail with
  `Extension does not export a valid factory function`.
- **MUST:** shared libs/tests live under `extensions/lib/` (a subdir with NO
  `index.ts` and NO `package.json` → loader skips it). Loader recurses only one
  level and only honors `index.ts`/`index.js`/`package.json` manifest.
- **MUST:** entry files import libs via `./lib/<name>.ts`; tests import siblings
  via `./<name>.ts`. Keep explicit `.ts` extensions (Node type-strip ESM).
- **MUST NOT:** add a new top-level `*.ts` unless it is a real extension.

## 2. Module boundaries (keep thin/pure split)

- `lib/ui-lib.ts` — **pure, no side effects, no pi imports** (only `@earendil-works/pi-tui`
  for `truncateToWidth`/`visibleWidth` + `Component` type). Unit-tested.
- `lib/cost-lib.ts` — data + fs only. No UI. Singleton: `recordCost`,
  `get30dCost` (rounded int), `get30dExact`.
- `lib/duration-lib.ts` — timer state only. No UI. `start`/`stop`/`getDurationMs`/`getDurationStr`/`fmt`.
- `cost-tracker.ts` / `prompt-duration.ts` — thin: wire pi events → lib calls,
  emit **plain** status strings via `ctx.ui.setStatus` (so default footer works
  when UI off). Cost status = `String(get30dCost())`; duration = `getDurationStr()`.
- `ui-extension.ts` — `UiController` (state) + `BoxedEditor` (render) + entry.

## 3. State model

- **MUST:** all mutable session state lives on a per-session `UiController`
  instance. No module-global mutable state. Recreate controller on
  `session_start`; null `activeTui` on `session_shutdown`.
- View is pull-based: `BoxedEditor.render(width)` reads controller each frame.
- State changes: mutate controller field → `controller.requestRender()`
  (`activeTui?.requestRender()`). Never reinstall the editor component to update
  model/thinking — mutate in place (`setModel`/`setThinking`).
- Stats are memoized via `statsDirty`. `markStatsDirty()` on `message_end`/
  `agent_end`. `ensureStats` recomputes when dirty, else refreshes only live
  fields (duration, cost30d). `recomputeStats` iterates `getBranch()` ONCE.

## 4. Rendering contract

- **MUST:** full `Theme` (has `fg()`) is `ctx.ui.theme` cast to `Theme`. The
  factory's `EditorTheme` only exposes `borderColor`. Border chars
  (`╭╮╰╯├┤│─`) → `theme.fg("border")`; labels/stats → `theme.fg("muted")`.
- **MUST:** no left gutter. Box width = `width`; inner content width = `width - 4`.
- **MUST:** build content lines only via `ui-lib` primitives (`contentLine`,
  `topBorder`, `junction`, `bottomBorder`, `fitBorder`). Never bare
  `"│ " + c + " │"` (breaks wide-char/ANSI width math).
- One combined box owns input + autocomplete list + `├──┤` junction + stats.
  Real footer slot is a zero-height stub (suppresses default stats footer; NO
  data-pump side effects).
- **MUST NOT:** call `setWorkingVisible(false)` — working row [7] is pi-fixed.
- Stats layout: `↑(input+cacheRead) ↓(output+cacheWrite)   $session/$30d   N%/Nk   ⏱ Ns`.
  **No cache-hit %.** up/down summed across assistant messages.
- List detection: locate editor's own bottom-border line (plain line of only box
  chars `\u2500-\u257F` + spaces) via scan, NO content regex. Lines after =
  dropdown → render inside box above junction, keep base arrow/highlight.
- **MUST:** blank spacer (whitespace `contentLine`, NOT a `├──┤` junction)
  separates input text rows from the autocomplete dropdown when list non-empty.

## 5. Lifecycle / events

- `session_start`: fresh controller, `activate` immediately (UI always on),
  refresh branch.
- activate sets editor component +
  zero-height footer + initial model/thinking. No `/ui` command; UI is always
  active (no deactivate path).
- `model_select` / `thinking_level_select`: guard `enabled`, mutate in place.
- `message_end` / `agent_end`: `markStatsDirty()`. `agent_start`: requestRender.
- **Duration:** `ui-extension` drives `duration-lib` `start()`/`stop()` itself on
  `agent_start`/`agent_end` (don't rely on `prompt-duration`'s singleton instance)
  and runs a ~300ms `setInterval` between them calling `requestRender()` so the
  live timer ticks in the box. Clear the interval on `agent_end`/`session_shutdown`.
- `session_shutdown`: disable, drop `activeTui`. Thin exts must `clearInterval`.

## 6. Dependencies & tooling

- **MUST NOT:** add npm dependencies. Stdlib + existing `@earendil-works/*` only.
- No `package.json`/test runner in repo. Tests run via Node built-in runner with
  type-stripping. ESM can't resolve `@earendil-works/*` through `NODE_PATH`, so
  workspace symlinks exist: `node_modules/@earendil-works/{pi-coding-agent,pi-tui,pi-ai}`
  → globally-installed package (+ its nested `pi-tui`/`pi-ai`). `node_modules/`
  is gitignored.
- Run tests:
  ```
  cd extensions && node --test --experimental-strip-types lib/ui-lib.test.ts
  ```
- **MUST:** keep `lib/ui-lib.ts` covered. Test pure helpers only (no TUI runtime):
  `fitBorder`, `wrapToWidth`, `formatStats`, `fmtTokens`, `abbreviateThinking`,
  `BoxWidget.render`.

## 7. Pure-helper invariants (don't regress)

- `fitBorder`: truncates right before left; `minimumGap=3`; exact total width;
  wide-char/ANSI safe.
- `wrapToWidth`: word boundaries; long words hard-split by **plain char** slicing
  (NOT `truncateToWidth`, which injects ANSI resets); empty → `[""]`.
- `padTo`/`contentLine`: pad to EXACT visible width via `visibleWidth`.
- `abbreviateThinking`: maps real `ThinkingLevel`s to clothing sizes —
  `off→off`, `minimal→xs`, `low→s`, `medium→m`, `high→l`, `xhigh→xl`; unknown
  passes through unchanged. NOT first-letter.
- `formatStats` precision: `ctxPercent` rendered `.toFixed(1)` (matches default
  footer); `cost30d` is pre-rounded int; `sessionCost` `.toFixed(2)`.
- `fmtTokens`: `<1000` plain, else `(n/1000).toFixed(1)+"k"`.
- `BoxWidget.render`: empty content → `[]` (hidden); else exact-width rounded box.

## 8. Known risks / verify at runtime

- Dropdown full-width highlight background may fight `│ … │` padding → `trimFill`
  re-pads only when plain length exceeds inner width; confirm no bleed.
- Confirm `super.render()` bottom-border line is the one matched by the box-char
  scan (structure may shift across pi versions).
- Zero-height footer must NOT suppress working/progress indicator.

## 9. Deferred (separate plan)

- `BoxWidget` is mechanism only. `aboveEditor` [3] / `belowEditor` [6] content
  wiring (answer-plan integration) is out of scope here.
