/**
 * UI Extension - one combined bordered editor box (input + autocomplete list +
 * stats) replacing the default footer/editor. Always active.
 *
 * Layout (full-width box, no left gutter):
 *  ╭─ <model> (<thinking>) ───────────── ⎇  <branch> ─╮
 *  │                                                  │
 *  │ user types here...                               │
 *  │ -> autocomplete item (inside box)                │
 *  │                                                  │
 *  ├──────────────────────────────────────────────────┤
 *  │ ↑Ntok (Ntok) ↓Ntok   $session/$30d   N%/Nk         │
 *  ╰──────────────────────────────────────────────────╯
 *
 * Architecture:
 * - UiController: per-session state holder (no module-global mutable state).
 * - BoxedEditor: single box owner; pulls controller stats each render.
 * - Stats sums: up = input+cacheRead+cacheWrite (total input),
 *   upUncached = input+cacheWrite (uncached), down = output (NO cache-hit %).
 *   Input shows as "<total> (<uncached>)".
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Box, Spacer, Text, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.ts";
import {
	abbreviateThinking,
	contentLine,
	fitBorder,
	formatStats,
	formatTurnSummary,
	junction,
	padTo,
	type StatsData,
	type TurnSummaryData,
} from "./lib/ui-lib.ts";
import { get30dCost } from "./lib/cost-lib.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const TURN_SUMMARY_TYPE = "turn-summary";

type TurnSummaryEntryData = TurnSummaryData;

/** Fill missing fields of old/partial stored entries with zero. */
function normalizeSummary(d: TurnSummaryData | undefined): TurnSummaryData {
	return {
		up: d?.up ?? 0,
		upUncached: d?.upUncached ?? 0,
		down: d?.down ?? 0,
		cost: d?.cost ?? 0,
		durationMs: d?.durationMs ?? 0,
	};
}

interface UsageSum {
	up: number;
	upUncached: number;
	down: number;
	cost: number;
}

/**
 * Sum assistant usage. usage.input is the new-input part after cache
 * reads/writes are split out. Total input = input+cacheRead+cacheWrite;
 * uncached input = input+cacheWrite; cacheWrite is not output.
 */
function sumUsage(usages: (Usage | undefined)[]): UsageSum {
	let up = 0, upUncached = 0, down = 0, cost = 0;
	for (const u of usages) {
		up += (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
		upUncached += (u?.input ?? 0) + (u?.cacheWrite ?? 0);
		down += u?.output ?? 0;
		cost += u?.cost?.total ?? 0;
	}
	return { up, upUncached, down, cost };
}

// --- UiController ------------------------------------------------------------

class UiController {
	activeTui?: TUI;
	model = "unknown";
	thinking = "off";
	branch?: string;
	enabled = false;
	execGit?: (ctx: ExtensionContext) => Promise<{ stdout: string }>;
	stats: StatsData = {
		up: 0, upUncached: 0, down: 0, sessionCost: 0, cost30d: 0,
		ctxPercent: null, ctxWindowK: null,
	};
	statsDirty = true;

	requestRender() {
		this.activeTui?.requestRender();
	}

	setModel(id: string) {
		this.model = id;
		this.requestRender();
	}

	setThinking(level: string) {
		this.thinking = abbreviateThinking(level);
		this.requestRender();
	}

	markStatsDirty() {
		this.statsDirty = true;
		this.requestRender();
	}

	async refreshBranch(ctx: ExtensionContext) {
		if (!this.execGit) return;
		const r = await this.execGit(ctx).catch(() => undefined);
		const s = r?.stdout.trim();
		this.branch = s && s.length > 0 ? s : undefined;
		this.requestRender();
	}

	/** Iterate branch assistant messages ONCE; recompute + cache stats. */
	recomputeStats(ctx: ExtensionContext) {
		const usages: (Usage | undefined)[] = [];
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				usages.push((e.message as AssistantMessage).usage);
			}
		}
		const { up, upUncached, down, cost: sessionCost } = sumUsage(usages);
		const usage = ctx.getContextUsage();
		const hasCtx = usage && usage.percent !== null && usage.contextWindow > 0;
		this.stats = {
			up, upUncached, down, sessionCost,
			cost30d: get30dCost(),
			ctxPercent: hasCtx ? usage.percent : null,
			ctxWindowK: hasCtx ? Math.round(usage.contextWindow / 1000) : null,
		};
		this.statsDirty = false;
	}

	ensureStats(ctx: ExtensionContext) {
		// Recompute when dirty; otherwise refresh only the 30d cost.
		if (this.statsDirty) this.recomputeStats(ctx);
		else this.stats = { ...this.stats, cost30d: get30dCost() };
	}
}

// --- BoxedEditor -------------------------------------------------------------

class BoxedEditor extends CustomEditor {
	private ctx: ExtensionContext;
	private controller: UiController;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		ctx: ExtensionContext,
		controller: UiController,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.ctx = ctx;
		this.controller = controller;
		controller.activeTui = tui;
	}

	render(width: number): string[] {
		const theme = this.ctx.ui.theme as Theme;
		const borderFn = (s: string) => theme.fg("border", s);
		const mutedFn = (s: string) => theme.fg("muted", s);

		const boxWidth = width;
		const innerWidth = boxWidth - 4;

		const editorLines = super.render(innerWidth);

		// editorLines = [topDash, ...content..., bottomDash, ...listRows?]
		// Detect editor's own bottom-border line: a plain line made only of box
		// chars (─ and corners) and spaces. Lines after it are the dropdown.
		const body = editorLines.slice(1); // drop topDash
		let bottomIdx = -1;
		for (let i = body.length - 1; i >= 0; i--) {
			const plain = body[i].replace(ANSI_RE, "");
			if (/^[\s\u2500-\u257F]*$/.test(plain) && plain.trim().length > 0) {
				bottomIdx = i;
				break;
			}
		}
		const textRows = bottomIdx >= 0 ? body.slice(0, bottomIdx) : body;
		const listRows = bottomIdx >= 0 ? body.slice(bottomIdx + 1) : [];

		this.controller.ensureStats(this.ctx);

		const out: string[] = [];
		const emit = (s: string) => out.push(s);

		// Top border with labels
		emit(
			borderFn("╭") +
			fitBorder(
				mutedFn(` ${this.controller.model} (${this.controller.thinking}) `),
				this.controller.branch ? mutedFn(` ⎇  ${this.controller.branch} `) : "",
				boxWidth - 2,
				borderFn,
				borderFn,
			) +
			borderFn("╮"),
		);

		// Top padding
		emit(contentLine("", boxWidth, borderFn));

		// Input text rows (skip bare separator lines -> blank)
		for (const l of textRows) {
			const plain = l.replace(ANSI_RE, "");
			const isSep = /^[\s\u2500]*$/.test(plain) && plain.trim().length > 0;
			emit(contentLine(isSep ? "" : trimFill(l, innerWidth), boxWidth, borderFn));
		}

		// Blank spacer between input and autocomplete list
		if (listRows.length > 0) emit(contentLine("", boxWidth, borderFn));

		// Autocomplete list inside the box (keep base arrow/highlight, re-frame)
		for (const l of listRows) {
			emit(contentLine(trimFill(l, innerWidth), boxWidth, borderFn));
		}

		// Bottom padding
		emit(contentLine("", boxWidth, borderFn));

		// Junction + stats + bottom border
		emit(junction(boxWidth, borderFn));
		emit(contentLine(mutedFn(formatStats(this.controller.stats)), boxWidth, borderFn));
		emit(borderFn("╰" + "─".repeat(boxWidth - 2) + "╯"));

		return out;
	}
}

/** Trim trailing full-width highlight fill from a dropdown line, pad to width. */
function trimFill(l: string, innerWidth: number): string {
	const plain = l.replace(ANSI_RE, "");
	if (plain.length <= innerWidth) return l;
	return padTo(l, innerWidth);
}

// --- Extension entry ---------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const execGit = (ctx: ExtensionContext) =>
		pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd });
	let agentStartMs: number | undefined;

	const renderSummaryRow = (data: TurnSummaryData, theme: Theme) => {
		const box = new Box(0, 0);
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("muted", formatTurnSummary(data)), 0, 0));
		box.addChild(new Spacer(5));
		return box;
	};

	pi.registerEntryRenderer<TurnSummaryEntryData>(TURN_SUMMARY_TYPE, (entry, _options, theme) =>
		renderSummaryRow(normalizeSummary(entry.data), theme),
	);

	let controller = new UiController();
	controller.execGit = execGit;

	function activate(ctx: ExtensionContext) {
		controller.enabled = true;
		controller.model = ctx.model?.name ?? "unknown";
		controller.thinking = abbreviateThinking(pi.getThinkingLevel());
		controller.markStatsDirty();
		void controller.refreshBranch(ctx);

		ctx.ui.setEditorComponent((tui, theme, kb) =>
			new BoxedEditor(tui, theme, kb, ctx, controller),
		);
		// Zero-height footer: suppress default stats footer (no data-pump).
		ctx.ui.setFooter(() => ({
			render: () => [],
			invalidate() {},
			dispose() {},
		}));
	}

	pi.on("session_start", async (_event, ctx) => {
		controller = new UiController();
		controller.execGit = execGit;
		agentStartMs = undefined;
		activate(ctx);
	});

	pi.on("model_select", (event, _ctx) => {
		if (!controller.enabled) return;
		controller.setModel(event.model.name);
	});

	pi.on("thinking_level_select", (event, _ctx) => {
		if (!controller.enabled) return;
		controller.setThinking(event.level);
	});

	// Per-step footer refresh: at turn_end the assistant message and its tool
	// results are already persisted, so the branch-based recompute sees them.
	pi.on("turn_end", (_event, _ctx) => {
		if (!controller.enabled) return;
		controller.markStatsDirty();
	});

	pi.on("agent_end", (event, _ctx) => {
		if (!controller.enabled) return;
		// Keep this markStatsDirty() even though turn_end already covers each
		// turn: it also catches error paths and post-run updates.
		controller.markStatsDirty();

		const usages: (Usage | undefined)[] = [];
		for (const message of event.messages) {
			if (message.role === "assistant") usages.push(message.usage);
		}
		const { up, upUncached, down, cost: totalCost } = sumUsage(usages);

		const durationMs = agentStartMs === undefined ? 0 : Math.max(0, Date.now() - agentStartMs);
		pi.appendEntry(TURN_SUMMARY_TYPE, {
			up,
			upUncached,
			down,
			cost: totalCost,
			durationMs,
		});

		agentStartMs = undefined;
	});

	pi.on("agent_start", (_event, _ctx) => {
		if (!controller.enabled) return;
		agentStartMs = Date.now();
	});

	pi.on("session_shutdown", async () => {
		controller.enabled = false;
		controller.activeTui = undefined;
	});
}
