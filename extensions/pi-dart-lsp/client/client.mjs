// stdlib-only glue between pi (or the test script) and the Dart daemon.
// Responsibilities:
//  - rebuild the daemon exe when daemon sources are newer than the binary
//    (stamp-based: newest source mtime vs binary mtime). Checked before every
//    connect, so a daemon built from older sources retires on the first ping.
//    The build writes a temp file and renames it over the binary (never writes
//    over a running executable).
//  - one shared connect-or-spawn per workspace for all concurrent calls
//  - a connection is used only after `ping` proves it is this state dir's
//    daemon (instance token from the port file) and sees the same workspace path
//  - spawn the daemon detached if none answers; spawn again if our child lost
//    the workspace lock and the holder went away
//  - one newline-delimited JSON RPC per call over TCP loopback; keep one open
//    connection per workspace (the daemon exits after an idle timeout without
//    connections)
//  - error responses and timeouts go straight to the caller; only a lost
//    connection reconnects (running daemon first) or spawns, then retries once
//  - delete daemon logs older than 7 days (`cleanupLogs`)
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exit code of a daemon that did not get the workspace lock (see daemon/bin/daemon.dart). */
const EXIT_LOCK_HELD = 75;
const SPAWN_DEADLINE_MS = 60000;
/** Ping bypasses the daemon's request queue, so this only has to cover a busy event loop. */
const PING_TIMEOUT_MS = 3000;
const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Error response from a healthy daemon (e.g. "file not found"). Never retried. */
export class DaemonError extends Error {}
/** RPC timeout. The connection stays: the daemon is likely busy with a queued request. */
export class DaemonTimeoutError extends Error {}
/** This state dir is served by a daemon that sees the workspace under another path. */
export class WorkspaceMismatchError extends Error {}

export class DartLspClient {
  /** @param {object} opts @param {string} opts.extRoot absolute path of the pi-dart-lsp dir */
  constructor({ extRoot }) {
    this.extRoot = extRoot;
    this._conns = new Map(); // workspace -> entry { socket, alive, pending, seq, daemonPid }
    this._opening = new Map(); // workspace -> Promise<entry> (in-flight connect/spawn)
  }

  _dartBin() {
    const flutter = process.env.FLUTTER_PATH;
    if (flutter && fs.existsSync(path.join(flutter, "bin", "dart"))) {
      return path.join(flutter, "bin", "dart");
    }
    return "dart";
  }

  _stateDir(ws) {
    return path.join(ws, ".pi", "lsp");
  }
  _binPath(ws) {
    return path.join(this._stateDir(ws), "bin", "daemon");
  }
  _portFile(ws) {
    return path.join(this._stateDir(ws), "port");
  }

  _walkSources(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "build") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this._walkSources(p, out);
      else if (e.name.endsWith(".dart")) out.push(p);
    }
  }

  _newestSourceMtime() {
    const files = [];
    this._walkSources(path.join(this.extRoot, "daemon"), files);
    let newest = 0;
    for (const f of files) newest = Math.max(newest, fs.statSync(f).mtimeMs);
    return newest;
  }

  ensureBuilt(ws) {
    const bin = this._binPath(ws);
    const newest = this._newestSourceMtime();
    const need = !fs.existsSync(bin) || fs.statSync(bin).mtimeMs < newest;
    if (!need) return;
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    // Never write over the running binary (ETXTBSY). Running daemons keep their inode; on their next
    // request they see the new (mtime, size) and retire. The random suffix keeps concurrent builds
    // apart: pi is PID 1 in every container.
    const tmp = `${bin}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const src = path.join(this.extRoot, "daemon", "bin", "daemon.dart");
    const r = spawnSync(this._dartBin(), ["compile", "exe", "-o", tmp, src], {
      cwd: path.join(this.extRoot, "daemon"),
      stdio: "pipe",
    });
    if (r.status !== 0) {
      fs.rmSync(tmp, { force: true });
      throw new Error(
        `daemon build failed (exit ${r.status}):\n${r.stderr?.toString() ?? ""}\n${r.stdout?.toString() ?? ""}`
      );
    }
    fs.renameSync(tmp, bin);
  }

  _tcpConnect(port, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1");
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`connect timeout on port ${port}`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        resolve(sock);
      });
      sock.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  /** Port file content: `<port> <instance token>`. */
  _readPortFile(ws) {
    try {
      const [p, token] = fs.readFileSync(this._portFile(ws), "utf8").trim().split(/\s+/);
      const port = parseInt(p, 10);
      if (Number.isFinite(port) && token) return { port, token };
    } catch {}
    return null;
  }

  /** Wraps a socket into an entry. Does NOT register it in `_conns`. */
  _wrap(ws, sock) {
    const entry = { socket: sock, alive: true, pending: new Map(), seq: 0, daemonPid: null };
    sock.on("data", (d) => {
      entry.buf = (entry.buf ?? "") + d.toString("utf8");
      let i;
      while ((i = entry.buf.indexOf("\n")) >= 0) {
        const line = entry.buf.slice(0, i).trim();
        entry.buf = entry.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = msg.id != null ? entry.pending.get(msg.id) : undefined;
        if (waiter) {
          entry.pending.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    });
    const drop = () => {
      entry.alive = false;
      for (const w of entry.pending.values()) {
        w.reject(new Error("daemon connection lost"));
      }
      entry.pending.clear();
      if (this._conns.get(ws) === entry) this._conns.delete(ws);
    };
    sock.on("close", drop);
    sock.on("error", drop);
    return entry;
  }

  /**
   * Connect to the port in the port file and verify it is THIS state dir's daemon: `ping` must return
   * the token from the port file (else the file is stale) and this workspace path (else the same
   * directory is mounted at another path in the daemon's container -> WorkspaceMismatchError).
   * Returns null when no verified daemon answers.
   */
  async _connectVerified(ws) {
    const info = this._readPortFile(ws);
    if (!info) return null;
    let sock;
    try {
      sock = await this._tcpConnect(info.port);
    } catch {
      return null;
    }
    const entry = this._wrap(ws, sock);
    let r;
    try {
      r = (await this._rpc(entry, "ping", {}, PING_TIMEOUT_MS)).result;
    } catch {}
    if (r && typeof r === "object" && r.token === info.token) {
      if (path.resolve(String(r.workspace)) === path.resolve(ws)) {
        entry.daemonPid = r.pid;
        return entry;
      }
      entry.alive = false;
      sock.destroy();
      throw new WorkspaceMismatchError(
        `${this._stateDir(ws)} is served by a daemon (pid ${r.pid} in another container) that sees ` +
          `the workspace as ${r.workspace}, but this pi sees it as ${ws}. The same directory is ` +
          `mounted at different paths. Start every pi on this workspace with the same mount choice, ` +
          `or end the other pi session(s).`
      );
    }
    entry.alive = false;
    sock.destroy();
    return null;
  }

  _logOfPid(ws, pid) {
    try {
      const name = fs
        .readdirSync(this._stateDir(ws))
        .filter((n) => n.endsWith(`-${pid}.log`))
        .sort()
        .pop();
      if (name) return path.join(this._stateDir(ws), name);
    } catch {}
    return path.join(this._stateDir(ws), `daemon-*-${pid}.log`);
  }

  /**
   * Spawn a daemon and wait until a verified daemon answers. Our child may lose the lock (exit 75)
   * to another daemon; then that daemon's port file answers instead. If our child is gone (lost the
   * lock, or exited cleanly) and still nobody answers, the holder went away (retired / idle /
   * stopped): spawn again. Any other exit fails at once with the child's log path.
   */
  async _spawnDaemon(ws) {
    const deadline = Date.now() + SPAWN_DEADLINE_MS;
    for (;;) {
      const child = spawn(this._binPath(ws), [ws], { detached: true, stdio: "ignore", env: process.env });
      const state = { exit: null, error: null };
      child.on("exit", (code, signal) => (state.exit = code ?? signal));
      child.on("error", (e) => (state.error = e));
      child.unref();
      for (;;) {
        const entry = await this._connectVerified(ws);
        if (entry) return entry;
        if (state.error) throw new Error(`daemon spawn failed: ${state.error.message}`);
        if (Date.now() > deadline) {
          throw new Error(`daemon did not start within ${SPAWN_DEADLINE_MS / 1000}s; see ${this._stateDir(ws)}/daemon-*.log`);
        }
        // Lost the lock, or a clean exit (stopped / retired before we got to it): spawn again.
        if (state.exit === EXIT_LOCK_HELD || state.exit === 0) break;
        if (state.exit !== null) {
          throw new Error(`daemon exited (${state.exit}) before serving; see ${this._logOfPid(ws, child.pid)}`);
        }
        await sleep(250);
      }
      await sleep(250);
    }
  }

  async _open(ws) {
    // Build first: a daemon running an older binary then retires on our ping (connection drops,
    // `_connectVerified` returns null) and we spawn the new one.
    this.ensureBuilt(ws);
    const entry = (await this._connectVerified(ws)) ?? (await this._spawnDaemon(ws));
    this._conns.set(ws, entry);
    return entry;
  }

  /** Live entry, or the ONE in-flight connect/spawn shared by all concurrent callers. */
  _getEntry(ws) {
    const entry = this._conns.get(ws);
    if (entry && entry.alive) return Promise.resolve(entry);
    let p = this._opening.get(ws);
    if (!p) {
      p = this._open(ws).finally(() => this._opening.delete(ws));
      this._opening.set(ws, p);
    }
    return p;
  }

  /** Forget a dead entry without touching any other one. */
  _forget(ws, entry) {
    entry.alive = false;
    if (this._conns.get(ws) === entry) this._conns.delete(ws);
  }

  _rpc(entry, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!entry.alive) {
        reject(new Error("daemon connection lost"));
        return;
      }
      const id = ++entry.seq;
      const t = setTimeout(() => {
        entry.pending.delete(id);
        reject(new DaemonTimeoutError(`daemon call timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      entry.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(t);
          if (msg.error != null) reject(new DaemonError(msg.error));
          else resolve(msg);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      entry.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /**
   * One JSON RPC to the daemon.
   * - Error responses and timeouts are thrown as-is (no retry, connection kept).
   * - Transport loss: forget only this call's entry, reconnect (running daemon first) or spawn, retry
   *   once.
   */
  async call(ws, method, params, { timeout = 180000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const entry = await this._getEntry(ws);
      try {
        return await this._rpc(entry, method, params, timeout);
      } catch (e) {
        if (e instanceof DaemonError || e instanceof DaemonTimeoutError || attempt >= 1) throw e;
        this._forget(ws, entry);
      }
    }
  }

  /** Hook path: fire-and-forget sync of a just-written .dart file. */
  sync(ws, file) {
    return this.call(ws, "sync", { path: file }).catch(() => {});
  }

  /**
   * Delete files not modified for 7 days: daemon logs (`daemon-<startMs>-<pid>.log`, trim
   * leftovers, legacy `daemon.log`) and binaries of interrupted builds (`bin/daemon.tmp-*`).
   */
  cleanupLogs(ws) {
    const cutoff = Date.now() - LOG_MAX_AGE_MS;
    const sweep = (dir, re) => {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!re.test(name)) continue;
        const p = path.join(dir, name);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
        } catch {}
      }
    };
    sweep(this._stateDir(ws), /^daemon(-\d+)*\.log(\.tmp)?$/);
    sweep(path.dirname(this._binPath(ws)), /^daemon\.tmp-/);
  }

  /** Close keep-alive connections; the daemon exits after its idle timeout. */
  dispose() {
    for (const entry of this._conns.values()) {
      entry.alive = false;
      try {
        entry.socket.destroy();
      } catch {}
    }
    this._conns.clear();
  }
}
