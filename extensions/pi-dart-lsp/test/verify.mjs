// Verification suite for the Dart LSP tools (spec: docs/pi-dart-lsp-idea.md in the pi repo root).
// Edits real tracked files, restores them in `finally`, fails on `git status` diff.
// Also guards the process lifecycle invariants: one daemon + one LSP per workspace, lock loser,
// retire handover, idle exit, stale port file, ping while busy, respawn after a lost lock,
// workspace mounted at another path, log content.
// Usage: node verify.mjs
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DartLspClient } from "../client/client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "..");
const WS = path.join(EXT, "flutter-example-project");

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

const eventsPath = path.join(WS, "lib/app/events.dart");
const fmtPath = path.join(WS, "lib/utils/formatters.dart");

async function stopDaemon(client) {
  try {
    await client.call(WS, "stop", {}, { timeout: 3000 });
  } catch {}
  for (let i = 0; i < 30; i++) {
    if (!fs.existsSync(path.join(WS, ".pi/lsp/port"))) return;
    await sleep(200);
  }
}

const originalEvents = fs.readFileSync(eventsPath, "utf8");
const originalFmt = fs.readFileSync(fmtPath, "utf8");

const LSP_DIR = path.join(WS, ".pi/lsp");
const BIN = path.join(LSP_DIR, "bin/daemon");
const pgrep = (pattern) =>
  execSync(`pgrep -f "${pattern}" || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
// [n]/[r] keep the pattern from matching the pgrep shell itself
const daemonPids = () => pgrep(`${WS}/.pi/lsp/bin/daemo[n] ${WS}`);
const lspPids = () => pgrep(`language-serve[r] --cache=${WS}/.pi/lsp/cache`);
const alive = (pid) => fs.existsSync(`/proc/${pid}`);
/** Log names: `daemon-<startMs>-<pid>.log`. */
const logNames = () => {
  try {
    return fs.readdirSync(LSP_DIR).filter((n) => /^daemon-\d+-\d+\.log$/.test(n)).sort();
  } catch {
    return [];
  }
};
const logOf = (pid) => {
  const name = logNames().filter((n) => n.endsWith(`-${pid}.log`)).pop();
  return name ? fs.readFileSync(path.join(LSP_DIR, name), "utf8") : "";
};
const logsSince = (ms) =>
  logNames()
    .filter((n) => Number(n.split("-")[1]) >= ms)
    .map((n) => fs.readFileSync(path.join(LSP_DIR, n), "utf8"));
async function waitFor(pred, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(step);
  }
  return !!(await pred());
}
/** Stop the daemon via RPC (if one runs), close the client's connection, wait until no daemon/LSP is left. */
async function stopAll(client) {
  if (daemonPids().length > 0) await stopDaemon(client);
  client.dispose();
  return waitFor(() => daemonPids().length === 0 && lspPids().length === 0, 20000);
}

function result(msg) {
  const r = msg && msg.result;
  return typeof r === "string" ? r : JSON.stringify(r ?? "");
}

async function main() {
  process.env.PI_DART_LSP_IDLE_TIMEOUT_S = "2"; // inherited by every spawned daemon
  const client = new DartLspClient({ extRoot: EXT });
  let coldMs = -1;
  const alias = path.join(os.tmpdir(), `pi-dart-lsp-alias-${process.pid}`);

  try {
    // ------------------------------------------------------------ cold start
    await stopAll(client);
    fs.rmSync(path.join(WS, ".pi/lsp"), { recursive: true, force: true });
    {
      const t = now();
      const r = result(await client.call(WS, "references", { symbol: "ShopEvent" }));
      coldMs = now() - t;
      check(
        "cold start: references resolves",
        /CartChangedEvent/.test(r) && /CatalogLoadedEvent/.test(r),
        `${Math.round(coldMs)}ms`
      );
    }

    // ---------------------------------------------------------- steady state
    {
      const times = [];
      for (let i = 0; i < 3; i++) {
        for (const [m, p] of [
          ["references", { symbol: "ShopEvent" }],
          ["definition", { symbol: "ShopEvent" }],
          ["hierarchy", { symbol: "ShopEvent" }],
          ["outline", { file: "lib/app/events.dart" }],
          ["diagnose", { files: ["lib/app/events.dart"] }],
        ]) {
          const t = now();
          const r = result(await client.call(WS, m, p));
          times.push(now() - t);
          if (typeof r !== "string" || r.length === 0)
            throw new Error(`${m} returned empty`);
        }
      }
      times.sort((a, b) => a - b);
      const med = times[Math.floor(times.length / 2)];
      check("steady state: median query < 1500ms", med < 1500, `${Math.round(med)}ms`);
    }

    // ---------------------------------------------------------------- churn
    {
      const times = [];
      const orig = fs.readFileSync(fmtPath, "utf8");
      try {
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(fmtPath, orig + `// churn turn ${i}\n`);
          client.sync(WS, fmtPath);
          const t = now();
          result(await client.call(WS, "diagnose", { files: ["lib/utils/formatters.dart"] }));
          times.push(now() - t);
          fs.writeFileSync(fmtPath, orig);
          client.sync(WS, fmtPath);
        }
      } finally {
        fs.writeFileSync(fmtPath, orig);
        client.sync(WS, fmtPath);
      }
      const med = times.sort((a, b) => a - b)[1];
      check("churn (edit+hook): median query < 2000ms", med < 2000, `${Math.round(med)}ms`);
    }

    // ---------------------------------------------------------- heavy churn
    {
      const eOrig = fs.readFileSync(eventsPath, "utf8");
      const fOrig = fs.readFileSync(fmtPath, "utf8");
      try {
        fs.writeFileSync(eventsPath, eOrig + `// heavy a\n`);
        fs.writeFileSync(fmtPath, fOrig + `// heavy b\n`);
        // no hook: the gate must catch both
        const t = now();
        const r = result(await client.call(WS, "outline", { file: "lib/utils/formatters.dart" }));
        const ms = now() - t;
        check("heavy churn: query after multi-edit (no hook)", /formatCents|money/.test(r), `${Math.round(ms)}ms`);
      } finally {
        fs.writeFileSync(eventsPath, eOrig);
        fs.writeFileSync(fmtPath, fOrig);
      }
    }

    // ------------------------------------- freshness, no hook (twin editor)
    {
      const added = `
final class TwinEvent extends ShopEvent {
  const TwinEvent();
}
`;
      try {
        fs.writeFileSync(eventsPath, originalEvents + added); // no sync
        let r = result(await client.call(WS, "hierarchy", { symbol: "ShopEvent" }));
        check("twin: hierarchy lists new subtype", /TwinEvent/.test(r));
        r = result(await client.call(WS, "diagnose", {}));
        check("twin: diagnose flags non-exhaustive switch", /TwinEvent/.test(r));
        fs.writeFileSync(eventsPath, originalEvents); // restore, no sync
        await sleep(1200); // let the forged/unconfirmed window pass
        r = result(await client.call(WS, "hierarchy", { symbol: "ShopEvent" }));
        check("twin restored: subtype gone", !/TwinEvent/.test(r));
        r = result(await client.call(WS, "diagnose", {}));
        check("twin restored: switch clean again", !/TwinEvent/.test(r));
      } finally {
        fs.writeFileSync(eventsPath, originalEvents);
        await sleep(300);
        await client.call(WS, "diagnose", {}, { timeout: 60000 }).catch(() => {});
      }
    }

    // ------------------------------------- freshness, forged (same size/mtime tick)
    {
      // c2a: clean rewrite (gets the file into the unconfirmed set, read
      // <1s after its mtime). c2b: byte-identical size, same mtime, but a
      // compile error — only a content re-read can detect it.
      const base = originalEvents;
      const c2a = base; // clean, same size
      const c2b = base.replace("  const ShopEvent();", "  const ShopEventXY;"); // 20 chars, broken
      if (c2a.length !== base.length || c2b.length !== base.length)
        throw new Error("forged test content must keep identical size");
      try {
        const st = fs.statSync(eventsPath);
        const t0 = new Date(st.mtimeMs);
        fs.writeFileSync(eventsPath, c2a); // fresh mtime T, clean content
        let r = result(await client.call(WS, "diagnose", { files: ["lib/app/events.dart"] }));
        check("forged: first rewrite seen (clean)", /No issues found/i.test(r), r.slice(0, 80));
        fs.writeFileSync(eventsPath, c2b);
        fs.utimesSync(eventsPath, t0, t0); // same mtime + same size as index
        r = result(await client.call(WS, "diagnose", {}));
        check("forged: same-size same-mtime rewrite detected", /ShopEventXY/.test(r));
      } finally {
        fs.writeFileSync(eventsPath, originalEvents);
        await client.call(WS, "diagnose", {}, { timeout: 60000 }).catch(() => {});
      }
    }

    // ------------------------------------------------- freshness, lifecycle
    {
      const probe = path.join(WS, "lib/utils/lifecycle_probe.dart");
      try {
        fs.writeFileSync(
          probe,
          `import 'package:shop_app/app/events.dart';\n\nint probe() {\n  final e = CartChangedEvent(totalItems: 1);\n  return e.totalItems + undefinedIdent;\n}\n`
        );
        let r = result(await client.call(WS, "references", { symbol: "CartChangedEvent" }));
        check("lifecycle: references include new file", /lifecycle_probe/.test(r));
        r = result(await client.call(WS, "diagnose", {}));
        check("lifecycle: diagnose flags new file", /lifecycle_probe|undefinedIdent/.test(r));
        fs.rmSync(probe, { force: true });
        r = result(await client.call(WS, "references", { symbol: "CartChangedEvent" }));
        check("lifecycle: references drop deleted file", !/lifecycle_probe/.test(r));
        r = result(await client.call(WS, "diagnose", {}));
        check("lifecycle: deleted file diagnostics cleared", !/lifecycle_probe|undefinedIdent/.test(r));
      } finally {
        fs.rmSync(probe, { force: true });
        await client.call(WS, "diagnose", {}, { timeout: 60000 }).catch(() => {});
      }
    }

    // ------------------------------------------------- freshness, ordering
    {
      let allOk = true;
      const bad = `  final orderSeq_ = undefinedSymbol;\n`;
      try {
        for (let i = 0; i < 5; i++) {
          fs.writeFileSync(fmtPath, originalFmt + bad);
          client.sync(WS, fmtPath);
          const r = result(await client.call(WS, "diagnose", { files: ["lib/utils/formatters.dart"] }));
          if (!/undefinedSymbol/.test(r)) allOk = false;
          fs.writeFileSync(fmtPath, originalFmt);
          client.sync(WS, fmtPath);
          const r2 = result(await client.call(WS, "diagnose", { files: ["lib/utils/formatters.dart"] }));
          if (/undefinedSymbol/.test(r2)) allOk = false;
        }
      } finally {
        fs.writeFileSync(fmtPath, originalFmt);
        client.sync(WS, fmtPath);
        await client.call(WS, "diagnose", {}, { timeout: 60000 }).catch(() => {});
      }
      check("ordering: 5x edit+hook+immediate diagnose never stale", allOk);
    }

    // ------------------------------------------- diagnose matches flutter analyze
    {
      // Inject a real warning so both sides report the same non-empty set.
      const fOrig = fs.readFileSync(fmtPath, "utf8");
      fs.writeFileSync(fmtPath, fOrig + "\nvoid _probeWarning() {\n  final unusedProbe = 1;\n}\n");
      client.sync(WS, fmtPath);
      try {
        const r = result(await client.call(WS, "diagnose", {}));
        const dartIssues = new Set();
        for (const line of r.split("\n")) {
          const m = line.match(/^\s*(error|warning) \u2022 (\S+) \u2022 .* \u2022 (\S+):(\d+):(\d+)$/);
          if (m) dartIssues.add(`${m[2]} ${m[3]}:${m[4]}`);
        }
        if (dartIssues.size === 0)
          check("diagnose vs flutter analyze", false, "injected warning not reported by diagnose");
        let flutterIssues = null;
        try {
          const out = execSync("$FLUTTER_PATH/bin/flutter analyze --no-pub 2>&1 || true", {
            cwd: WS,
            encoding: "utf8",
            timeout: 240000,
          });
          flutterIssues = new Set();
          for (const line of out.split("\n")) {
            const m = line.match(/^(error|warning) \u2022 .+ \u2022 (\S+):(\d+):\d+ \u2022 (\S+)$/);
            if (m) flutterIssues.add(`${m[4]} ${m[2]}:${m[3]}`);
          }
        } catch (e) {
          check("diagnose vs flutter analyze", false, `flutter analyze failed: ${String(e).slice(0, 200)}`);
        }
        if (flutterIssues) {
          let match = true;
          for (const x of flutterIssues) if (!dartIssues.has(x)) match = false;
          for (const x of dartIssues) if (!flutterIssues.has(x)) match = false;
          check(
            "diagnose matches flutter analyze (errors+warnings)",
            match,
            `dart=${dartIssues.size} flutter=${flutterIssues.size}`
          );
        }
      } finally {
        fs.writeFileSync(fmtPath, fOrig);
        client.sync(WS, fmtPath);
        await client.call(WS, "diagnose", {}, { timeout: 60000 }).catch(() => {});
      }
    }

    // ------------------------------------------------- LSP child crash/retry
    // Crash the language-server child out-of-band (like a segfault); the
    // daemon must exit and the client must respawn + retry transparently.
    {
      const { execSync: es } = await import("node:child_process");
      const pids = es(
        // [r] keeps the pattern from matching this very shell's command line
        `pgrep -f "language-serve[r] --cache=${WS}/.pi/lsp/cache" || true`,
        { encoding: "utf8" }
      ).trim();
      if (pids) {
        for (const p of pids.split("\n")) process.kill(Number(p), "SIGKILL");
      }
      await sleep(500);
      const t = now();
      const r = result(await client.call(WS, "references", { symbol: "ShopEvent" }));
      const ms = now() - t;
      check("lsp crash: transparent respawn + one retry", /CartChangedEvent/.test(r), `${Math.round(ms)}ms`);
    }

    // ------------------------------------------------- process lifecycle
    // Each check starts from "no daemon, no LSP". Idle checks rely on PI_DART_LSP_IDLE_TIMEOUT_S=2.

    // parallel calls from a fresh client -> exactly one daemon + one LSP
    {
      await stopAll(client);
      const c = new DartLspClient({ extRoot: EXT });
      const calls = [
        ["references", { symbol: "ShopEvent" }],
        ["definition", { symbol: "ShopEvent" }],
        ["outline", { file: "lib/app/events.dart" }],
        ["hierarchy", { symbol: "ShopEvent" }],
        ["outline", { file: "lib/does_not_exist.dart" }], // error response must not tear anything down
        ["diagnose", { files: ["lib/app/events.dart"] }],
      ];
      const rs = await Promise.allSettled(calls.map(([m, p]) => c.call(WS, m, p)));
      const okCount = rs.filter((r) => r.status === "fulfilled").length;
      const errOk = rs[4].status === "rejected" && /not found/.test(String(rs[4].reason));
      check(
        "parallel: 6 calls (1 error) -> 1 daemon + 1 LSP",
        okCount === 5 && errOk && daemonPids().length === 1 && lspPids().length === 1,
        `ok=${okCount} errOk=${errOk} daemons=${daemonPids().length} lsps=${lspPids().length}`
      );
      c.dispose();
    }

    // two clients (two pi sessions) starting concurrently share one daemon
    {
      await stopAll(client);
      const a = new DartLspClient({ extRoot: EXT });
      const b = new DartLspClient({ extRoot: EXT });
      await Promise.all([
        a.call(WS, "outline", { file: "lib/app/events.dart" }),
        b.call(WS, "outline", { file: "lib/app/events.dart" }),
      ]);
      const pa = a._conns.get(WS)?.daemonPid;
      const pb = b._conns.get(WS)?.daemonPid;
      await sleep(11000); // let a lock loser give up
      check(
        "second client: shares the daemon",
        pa != null && pa === pb && daemonPids().length === 1 && lspPids().length === 1,
        `a=${pa} b=${pb} daemons=${daemonPids().length} lsps=${lspPids().length}`
      );
      a.dispose();
      b.dispose();
    }

    // manually started second daemon loses the lock, starts no LSP, logs it
    {
      await stopAll(client);
      await client.call(WS, "outline", { file: "lib/app/events.dart" });
      const lspBefore = lspPids().length;
      const loser = spawn(BIN, [WS], { stdio: "ignore", env: process.env });
      const code = await new Promise((res) => {
        const t = setTimeout(() => res("timeout"), 15000);
        loser.on("exit", (c) => {
          clearTimeout(t);
          res(c);
        });
      });
      check(
        "lock loser: exits 75 without LSP and logs it",
        code === 75 && lspPids().length === lspBefore && /lock held/.test(logOf(loser.pid)),
        `exit=${code} lsps=${lspPids().length}`
      );
    }

    // retire handover: replaced binary -> one new daemon, old LSP reaped
    {
      await stopAll(client);
      await client.call(WS, "outline", { file: "lib/app/events.dart" });
      const [oldDaemon] = daemonPids();
      const [oldLsp] = lspPids();
      const tmp = `${BIN}.tmp-test`;
      fs.copyFileSync(BIN, tmp); // new mtime, same content: "a newer build"
      fs.renameSync(tmp, BIN);
      const r = result(await client.call(WS, "references", { symbol: "ShopEvent" }));
      const ds = daemonPids();
      check(
        "handover: one new daemon, old LSP gone",
        /CartChangedEvent/.test(r) && ds.length === 1 && ds[0] !== oldDaemon && !alive(oldLsp) &&
          /binary replaced/.test(logOf(oldDaemon)),
        `daemons=${ds} old=${oldDaemon} oldLspAlive=${alive(oldLsp)}`
      );
    }

    // idle shutdown without any connection
    {
      await stopAll(client);
      const d = spawn(BIN, [WS], { stdio: "ignore", env: process.env });
      const exited = await waitFor(() => d.exitCode !== null, 20000);
      check(
        "idle: never-connected daemon exits",
        exited && /shutting down: idle/.test(logOf(d.pid)) && lspPids().length === 0,
        `exited=${exited} lsps=${lspPids().length}`
      );
    }

    // idle shutdown after the last disconnect; alive while connected
    {
      await stopAll(client);
      const c = new DartLspClient({ extRoot: EXT });
      await c.call(WS, "outline", { file: "lib/app/events.dart" });
      const pid = c._conns.get(WS).daemonPid;
      await sleep(4000); // > idle timeout, but connected
      const aliveWhileConnected = alive(pid);
      c.dispose();
      const exited = await waitFor(() => !alive(pid), 15000);
      check(
        "idle: alive while connected, exits after last disconnect",
        aliveWhileConnected && exited && /shutting down: idle/.test(logOf(pid)),
        `aliveWhileConnected=${aliveWhileConnected} exited=${exited}`
      );
    }

    // stale port file pointing at a foreign listener is ignored
    {
      await stopAll(client);
      const foreign = net.createServer((s) => s.on("data", () => {})); // accepts, never answers
      await new Promise((res) => foreign.listen(0, "127.0.0.1", res));
      fs.mkdirSync(LSP_DIR, { recursive: true });
      fs.writeFileSync(path.join(LSP_DIR, "port"), `${foreign.address().port} stale-token`);
      const c = new DartLspClient({ extRoot: EXT });
      try {
        const r = result(await c.call(WS, "references", { symbol: "ShopEvent" }));
        check(
          "stale port: foreign listener ignored, own daemon started",
          /CartChangedEvent/.test(r) && daemonPids().length === 1 && c._conns.get(WS).daemonPid != null,
          `daemons=${daemonPids().length}`
        );
      } finally {
        c.dispose();
        foreign.close();
      }
    }

    // ping is answered while the request queue is blocked (busy daemon is not taken for dead)
    {
      await stopAll(client);
      const a = new DartLspClient({ extRoot: EXT });
      const b = new DartLspClient({ extRoot: EXT });
      await a.call(WS, "outline", { file: "lib/app/events.dart" });
      const pid = a._conns.get(WS).daemonPid;
      const [lsp] = lspPids();
      const t0 = Date.now();
      process.kill(lsp, "SIGSTOP"); // the next LSP request blocks the daemon's queue
      let busy;
      try {
        busy = a.call(WS, "references", { symbol: "ShopEvent" });
        await sleep(500);
        const t = now();
        let pingOk = false;
        try {
          await b.call(WS, "ping", {}, { timeout: 5000 });
          pingOk = true;
        } catch {}
        const ms = now() - t;
        process.kill(lsp, "SIGCONT");
        const r = result(await busy);
        check(
          "busy daemon: ping answered while the queue is blocked",
          pingOk && ms < 5000 && b._conns.get(WS)?.daemonPid === pid && daemonPids().length === 1 &&
            /CartChangedEvent/.test(r) && !logsSince(t0).some((l) => /lock held/.test(l)),
          `pingOk=${pingOk} ${Math.round(ms)}ms daemons=${daemonPids().length}`
        );
      } finally {
        try {
          process.kill(lsp, "SIGCONT");
        } catch {}
        await busy?.catch(() => {});
        a.dispose();
        b.dispose();
      }
    }

    // our spawn loses the lock, then the holder dies -> client spawns again
    {
      await stopAll(client);
      const a = new DartLspClient({ extRoot: EXT });
      await a.call(WS, "outline", { file: "lib/app/events.dart" });
      const holder = a._conns.get(WS).daemonPid;
      const [holderLsp] = lspPids();
      a.dispose();
      const t0 = Date.now();
      process.kill(holder, "SIGSTOP"); // holds the lock, answers nothing
      const b = new DartLspClient({ extRoot: EXT });
      try {
        const p = b.call(WS, "outline", { file: "lib/app/events.dart" });
        p.catch(() => {});
        const lost = await waitFor(() => logsSince(t0).some((l) => /lock held/.test(l)), 30000);
        process.kill(holderLsp, "SIGKILL");
        process.kill(holder, "SIGKILL");
        let ok = false;
        let detail = "";
        try {
          ok = /ShopEvent/.test(result(await p));
        } catch (e) {
          detail = String(e).slice(0, 150);
        }
        const pb = b._conns.get(WS)?.daemonPid;
        check(
          "lost lock + holder gone: client spawns again",
          lost && ok && pb != null && pb !== holder && daemonPids().length === 1 && lspPids().length === 1,
          `lost=${lost} ok=${ok} daemons=${daemonPids().length} ${detail}`
        );
      } finally {
        try {
          process.kill(holder, "SIGKILL");
        } catch {}
        b.dispose();
      }
    }

    // same state dir under another workspace path (other mount) -> clear error, no spawn
    {
      await stopAll(client);
      await client.call(WS, "outline", { file: "lib/app/events.dart" });
      const [pid] = daemonPids();
      fs.symlinkSync(WS, alias);
      const c = new DartLspClient({ extRoot: EXT });
      let err = "";
      try {
        await c.call(alias, "outline", { file: "lib/app/events.dart" });
      } catch (e) {
        err = String(e?.message ?? e);
      }
      const ds = daemonPids();
      check(
        "other mount path: clear error, no second daemon",
        /mounted at different paths/.test(err) && ds.length === 1 && ds[0] === pid,
        `daemons=${ds} err=${err.slice(0, 80)}`
      );
      c.dispose();
    }

    // shutdown reason + clean LSP exit are in the daemon's own log
    {
      await stopAll(client);
      await client.call(WS, "outline", { file: "lib/app/events.dart" });
      const pid = Number(fs.readFileSync(path.join(LSP_DIR, "pid"), "utf8"));
      await stopAll(client);
      const log = logOf(pid);
      check(
        "log: shutdown reason + LSP exit code 0 written",
        /\[daemon\] shutting down: stop requested/.test(log) &&
          /language server stopped \(exit code 0\)/.test(log) &&
          /^\d{4}-\d\d-\d\dT\S+ \[daemon\] start pid=/.test(log),
        log.trim().split("\n").slice(-3).join(" | ")
      );
    }
  } catch (e) {
    check("suite completed without crash", false, String(e).slice(0, 300));
  } finally {
    fs.rmSync(alias, { force: true });
    // workspace must be pristine (scoped to WS: the suite only edits files there)
    let gitOk = true;
    let gitOut = "";
    try {
      gitOut = execSync("git status --porcelain --untracked-files=no -- .", {
        cwd: WS,
        encoding: "utf8",
      }).trim();
      gitOk = gitOut === "";
    } catch {
      gitOk = false;
    }
    check("git status clean after restore", gitOk, gitOut.slice(0, 200));
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length === 0 && gitOk ? 0 : 1);
  }
}

main();
