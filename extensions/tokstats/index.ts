import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Exponential moving average alpha for the tok/s estimate. Chosen from a
// target effective sample size (ESS):  alpha = 2 / (ESS + 1).
// The ESS of an EMA is (2 - alpha) / alpha. That comes from Kish's effective
// sample size n_eff = 1 / sum(w_i^2), with the EMA weights w_k = alpha *
// (1 - alpha)^k for a sample k steps back. ESS is the number of recent
// samples the average effectively weights. alpha = 0.01 gives ESS ~= 200,
// or about 2 days at ~50 steps per day.
const EMA_ALPHA = 0.01;
const LOCK_STALE_MS = 10000;
const LOCK_MAX_WAIT_MS = 5000;
const LOCK_RETRY_MS = 20;

// Ignore very short outputs when measuring output token speed. Short replies
// from remote providers are often delivered in a single chunk, so the measured
// generation time is not meaningful.
const MIN_OUTPUT_TOKENS = 50;

// Persist in the pi config dir (~/.pi/agent) so data accumulates across
// sessions and survives extension reinstall/relocation.
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ||
  path.join(os.homedir(), ".pi", "agent");
const STATS_PATH = path.join(AGENT_DIR, "tokstats.json");
const LOCK_PATH = `${STATS_PATH}.lock`;

interface ModelStats {
  inputTokPerSec: number;
  outputTokPerSec: number;
  lastInputTokPerSec: number;
  lastOutputTokPerSec: number;
  inputSamples: number;
  outputSamples: number;
  /** Cumulative input tokens seen for this model, across every message. */
  inputTokens: number;
  /** Cumulative output tokens seen for this model, across every message. */
  outputTokens: number;
  lastUpdated: number;
}

interface StatsFile {
  version: number;
  models: Record<string, ModelStats>;
}

type ActiveTiming = {
  startMs: number;
  firstTokenMs?: number;
};

type PendingSample = {
  key: string;
  kind: "input" | "output" | "tokens";
  sample?: number;
  inputTokens?: number;
  outputTokens?: number;
};

function emptyModelStats(): ModelStats {
  return {
    inputTokPerSec: 0,
    outputTokPerSec: 0,
    inputSamples: 0,
    outputSamples: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastUpdated: 0,
  };
}

// A stored key is `${provider}/${model}`. The model is reduced to its last
// path segment at collection time, so it never contains "/". Split on the
// last slash so URL-style providers (e.g. "llama-server=http://host:port")
// keep their slashes instead of being cut off.
function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf("/");
  if (i === -1) {
    return [key, ""];
  }
  return [key.slice(0, i), key.slice(i + 1)];
}

async function loadStats(): Promise<StatsFile> {
  try {
    const data = await fs.promises.readFile(STATS_PATH, "utf8");
    return JSON.parse(data) as StatsFile;
  } catch {
    // missing or corrupt file
  }
  return { version: 1, models: {} };
}

async function saveStats(stats: StatsFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(STATS_PATH), { recursive: true });
  const tmp = `${STATS_PATH}.${process.pid}.tmp`;
  await fs.promises.writeFile(
    tmp,
    JSON.stringify(stats, null, 2),
    "utf8",
  );
  await fs.promises.rename(tmp, STATS_PATH);
}

async function withLock(fn: () => Promise<void>): Promise<boolean> {
  const start = Date.now();
  while (true) {
    let fh: fs.promises.FileHandle | undefined;
    try {
      fh = await fs.promises.open(LOCK_PATH, "wx");
      try {
        await fn();
        return true;
      } finally {
        await fh.close().catch(() => {});
        await fs.promises.unlink(LOCK_PATH).catch(() => {});
      }
    } catch (err: any) {
      await fh?.close().catch(() => {});
      if (err.code !== "EEXIST") {
        return false;
      }
      // Stale lock? (owning process died without cleaning up)
      try {
        const stat = await fs.promises.stat(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.promises.unlink(LOCK_PATH).catch(() => {});
          continue;
        }
      } catch {
        // lock disappeared; try again
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

function updateEma(
  oldValue: number,
  sampleCount: number,
  sample: number,
  alpha: number,
): [number, number] {
  if (sampleCount === 0) {
    return [sample, 1];
  }
  return [alpha * sample + (1 - alpha) * oldValue, sampleCount + 1];
}

function applyPending(stats: StatsFile, pending: PendingSample[]): void {
  for (const entry of pending) {
    const { key } = entry;
    const current = stats.models[key] ?? emptyModelStats();

    // Cumulative token totals. Counted for every classified message, no
    // matter the timing or abort state, because those tokens were used.
    // The ?? 0 guards accept keys written before these fields existed.
    if (entry.kind === "tokens") {
      current.inputTokens = (current.inputTokens ?? 0) + (entry.inputTokens ?? 0);
      current.outputTokens = (current.outputTokens ?? 0) + (entry.outputTokens ?? 0);
      current.lastUpdated = Date.now();
      stats.models[key] = current;
      continue;
    }

    if (entry.kind === "input") {
      current.lastInputTokPerSec = current.inputTokPerSec;
      [current.inputTokPerSec, current.inputSamples] = updateEma(
        current.inputTokPerSec,
        current.inputSamples,
        entry.sample ?? 0,
        EMA_ALPHA,
      );
    } else {
      current.lastOutputTokPerSec = current.outputTokPerSec;
      [current.outputTokPerSec, current.outputSamples] = updateEma(
        current.outputTokPerSec,
        current.outputSamples,
        entry.sample ?? 0,
        EMA_ALPHA,
      );
    }
    current.lastUpdated = Date.now();
    stats.models[key] = current;
    continue;
  }
}

// Format a token total with thousands separators for reading.
function formatTokens(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

// A model reaches "Enough data" once it has at least this many uncached
// input tokens and output tokens. Below that its tok/s is too sparse to trust.
const ENOUGH_INPUT = 500_000;
const ENOUGH_OUTPUT = 500_000;

type Entry = [string, ModelStats];

function hasEnough(s: ModelStats): boolean {
  return (s.inputTokens ?? 0) >= ENOUGH_INPUT && (s.outputTokens ?? 0) >= ENOUGH_OUTPUT;
}

// Build one aligned table (header + rows) for a set of entries.
function buildTable(entries: Entry[]): string {
  const providerWidth = Math.max(
    "provider".length,
    ...entries.map(([key]) => splitKey(key)[0].length),
  );
  const modelWidth = Math.max(
    "model".length,
    ...entries.map(([key]) => splitKey(key)[1].length),
  );
  const inRateWidth = Math.max(
    "uncached input tok/s".length,
    ...entries.map(([, s]) => s.inputTokPerSec.toFixed(0).length),
  );
  const outRateWidth = Math.max(
    "output tok/s".length,
    ...entries.map(([, s]) => s.outputTokPerSec.toFixed(0).length),
  );
  const inTokWidth = Math.max(
    "uncached input tokens".length,
    ...entries.map(([, s]) => formatTokens(s.inputTokens).length),
  );
  const outTokWidth = Math.max(
    "output tokens".length,
    ...entries.map(([, s]) => formatTokens(s.outputTokens).length),
  );

  const header =
    `${"provider".padEnd(providerWidth)}  ${"model".padEnd(modelWidth)}  ` +
    `${"uncached input tok/s".padStart(inRateWidth)}  ${"output tok/s".padStart(outRateWidth)}  ` +
    `${"uncached input tokens".padStart(inTokWidth)}  ${"output tokens".padStart(outTokWidth)}  ` +
    `${"samples".padStart(7)}`;

  const rows = entries.map(([key, s]) => {
    const [provider, model] = splitKey(key);
    const sampleStr = `${s.inputSamples}/${s.outputSamples}`;
    return (
      `${(provider ?? "").padEnd(providerWidth)}  ${(model ?? "").padEnd(modelWidth)}  ` +
      `${s.inputTokPerSec.toFixed(0).padStart(inRateWidth)}  ` +
      `${s.outputTokPerSec.toFixed(0).padStart(outRateWidth)}  ` +
      `${formatTokens(s.inputTokens).padStart(inTokWidth)}  ` +
      `${formatTokens(s.outputTokens).padStart(outTokWidth)}  ` +
      `${sampleStr.padStart(7)}`
    );
  });

  return [header, ...rows].join("\n");
}

export default function (pi: ExtensionAPI) {
  let active: ActiveTiming | undefined;
  const pending: PendingSample[] = [];

  async function flushPending(): Promise<void> {
    if (pending.length === 0) return;
    const todo = pending.splice(0, pending.length);
    const ok = await withLock(async () => {
      const stats = await loadStats();
      applyPending(stats, todo);
      await saveStats(stats);
    });
    if (!ok) {
      // Lock failed; put samples back to retry later.
      pending.unshift(...todo);
    }
  }

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    active = { startMs: Date.now() };
  });

  pi.on("message_update", async () => {
    if (!active || active.firstTokenMs != null) return;
    active.firstTokenMs = Date.now();
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || !active) return;

    const timing = active;
    active = undefined;

    const message = event.message as AssistantMessage;
    const usage = message.usage;
    if (!usage) return;

    // Provider id is canonical on the message. Model id may be a full
    // resource path (e.g. "accounts/fireworks/models/kimi-k3") — keep the
    // last segment. Without both, drop the sample instead of writing
    // misleading stats.
    const provider = message.provider;
    const modelId = message.model;
    if (!provider || !modelId) return;
    const model = modelId.slice(modelId.lastIndexOf("/") + 1);
    const key = `${provider}/${model}`;

    const endMs = Date.now();

    // Aborted/errored messages: prompt processing is complete once the
    // first token arrived, but generation is unfinished — skip output.
    const aborted =
      message.stopReason === "aborted" || message.stopReason === "error";

    // Tool calls are often emitted as a single chunk, even by providers that
    // stream normal text. Their measured tok/s is not comparable to generated
    // text, so skip their output samples while still counting the tokens used.
    const isToolCall =
      message.stopReason === "toolUse" ||
      message.content.some((item) => item.type === "toolCall");

    // Uncached input tokens: new input tokens plus newly-written cache
    // tokens. `usage.input` already excludes cache reads and writes; add
    // cacheWrite back so the stored total and tok/s rate reflect real
    // uncached prompt usage.
    const uncachedInput = (usage.input ?? 0) + (usage.cacheWrite ?? 0);

    if (
      uncachedInput > 0 &&
      timing.firstTokenMs != null &&
      timing.firstTokenMs > timing.startMs
    ) {
      pending.push({
        key,
        kind: "input",
        sample: uncachedInput / ((timing.firstTokenMs - timing.startMs) / 1000),
      });
    }

    if (
      !aborted &&
      !isToolCall &&
      usage.output &&
      usage.output >= MIN_OUTPUT_TOKENS &&
      timing.firstTokenMs != null &&
      endMs > timing.firstTokenMs
    ) {
      pending.push({
        key,
        kind: "output",
        sample: usage.output / ((endMs - timing.firstTokenMs) / 1000),
      });
    }

    // Cumulative token totals for this message. Count every classified
    // message, even aborted or errored ones, because those tokens were used.
    // Store uncached input, so cache hits do not count toward usage totals.
    pending.push({
      key,
      kind: "tokens",
      inputTokens: uncachedInput,
      outputTokens: usage.output || 0,
    });

    await flushPending();
  });

  pi.on("agent_settled", async () => {
    await flushPending();
  });

  pi.registerCommand("tokstats", {
    description: "Show per-model tok/s and token totals",
    handler: async (_args, ctx) => {
      await flushPending();
      const stats = await loadStats();

      const entries = Object.entries(stats.models).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (entries.length === 0) {
        ctx.ui.notify("No tok/s data yet.", "info");
        return;
      }

      const STABILITY_THRESHOLD = 0.03;

      const stable = entries.filter(([, s]) => {
        const lastInput = s.lastInputTokPerSec || 1;
        const lastOutput = s.lastOutputTokPerSec || 1;
        const inputStable = Math.abs(s.inputTokPerSec - lastInput) / lastInput < STABILITY_THRESHOLD;
        const outputStable = Math.abs(s.outputTokPerSec - lastOutput) / lastOutput < STABILITY_THRESHOLD;
        return inputStable && outputStable;
      }).sort(([, a], [, b]) => b.outputTokPerSec - a.outputTokPerSec);

      const unstable = entries.filter(([, s]) => {
        const lastInput = s.lastInputTokPerSec || 1;
        const lastOutput = s.lastOutputTokPerSec || 1;
        const inputStable = Math.abs(s.inputTokPerSec - lastInput) / lastInput < STABILITY_THRESHOLD;
        const outputStable = Math.abs(s.outputTokPerSec - lastOutput) / lastOutput < STABILITY_THRESHOLD;
        return !(inputStable && outputStable);
      });

      const sections: string[] = [];
      if (stable.length > 0) {
        sections.push(`Stable\n${buildTable(stable)}`);
      }
      if (unstable.length > 0) {
        sections.push(`Unstable/Warming up\n${buildTable(unstable)}`);
      }

      const table = sections.join("\n\n");
      if (ctx.hasUI) {
        ctx.ui.notify(table, "info");
      } else {
        console.log(table);
      }
    },
  });
}
