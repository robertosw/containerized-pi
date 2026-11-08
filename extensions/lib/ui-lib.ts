/**
 * ui-lib - shared, pure UI helpers + BoxWidget.
 *
 * Pure (unit-tested): fitBorder, wrapToWidth, padTo, abbreviateThinking,
 * fmtTokens, formatStats, box-draw primitives.
 * BoxWidget: self-drawing rounded bordered box (mechanism only).
 *
 * fitBorder vendored from examples/extensions/border-status-editor.ts
 * (do NOT import from package).
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type StyleFn = (s: string) => string;
const ident: StyleFn = (s) => s;

// --- fitBorder (vendored) ----------------------------------------------------

export function fitBorder(
	left: string,
	right: string,
	width: number,
	border: StyleFn,
	fill: StyleFn = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 3;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

// --- Text helpers ------------------------------------------------------------

/** Truncate+pad to exact visible width. */
export function padTo(s: string, width: number): string {
	const t = truncateToWidth(s, width, "");
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

/** Word-wrap plain text to width; hard-splits over-long words. Empty -> []. */
export function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	for (const para of text.split("\n")) {
		if (para.length === 0) {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of para.split(/\s+/)) {
			if (word.length === 0) continue;
			let w = word;
			// hard-split words longer than width (plain-text char slicing)
			while (visibleWidth(w) > width) {
				if (line.length > 0) {
					out.push(line);
					line = "";
				}
				let cut = 0, acc = 0;
				while (cut < w.length && acc + visibleWidth(w[cut]) <= width) {
					acc += visibleWidth(w[cut]);
					cut++;
				}
				if (cut === 0) cut = 1;
				out.push(w.slice(0, cut));
				w = w.slice(cut);
			}
			if (line.length === 0) {
				line = w;
			} else if (visibleWidth(line) + 1 + visibleWidth(w) <= width) {
				line += " " + w;
			} else {
				out.push(line);
				line = w;
			}
		}
		if (line.length > 0) out.push(line);
	}
	return out;
}

/** Map thinking levels to clothing sizes (xs,s,m,l,xl,xxl). */
export function abbreviateThinking(level: string): string {
	switch (level) {
		case "off": return "off";
		case "minimal": return "xs";
		case "low": return "s";
		case "medium": return "m";
		case "high": return "l";
		case "xhigh": return "xl";
		default: return level;
	}
}

export function fmtTokens(n: number): string {
	// Integer mantissa only, no decimals: 125000 -> "125k", 999 -> "999".
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(0)}k`;
}

export function formatDurationCompact(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		if (seconds === 0) return `${minutes}min`;
		return `${minutes}min ${seconds}s`;
	}

	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	if (remMinutes === 0) return `${hours}h`;
	return `${hours}h ${remMinutes}min`;
}

// --- Stats -------------------------------------------------------------------

export interface StatsData {
	up: number;            // input + cacheRead + cacheWrite (total input tokens)
	upUncached: number;    // input + cacheWrite (uncached input tokens)
	down: number;          // output only (cacheWrite is not output)
	sessionCost: number;   // Σ per-message cost
	cost30d: number;       // rounded int from cost-lib
	ctxPercent: number | null;
	ctxWindowK: number | null;
}

export interface TurnSummaryData {
	up: number;            // total input tokens for this assistant turn
	upUncached: number;    // uncached input tokens for this assistant turn
	down: number;          // output tokens for this assistant turn
	cost: number;          // per-message total cost
	durationMs: number;    // elapsed time for this assistant turn
}

/** Compact single-turn summary for history rows. */
export function formatTurnSummary(s: TurnSummaryData, width?: number): string {
	const line = (
		`↑ ${fmtTokens(s.up)} (${fmtTokens(s.upUncached)}) ` +
		`↓ ${fmtTokens(s.down)} │ $${s.cost.toFixed(2)} │ ` +
		`⏱ ${formatDurationCompact(s.durationMs)}`
	);
	return width === undefined ? line : padTo(line, width);
}

/** Pure stats string. NO cache-hit %. */
export function formatStats(s: StatsData): string {
	const ctx = (s.ctxPercent !== null && s.ctxWindowK !== null)
		? `${s.ctxPercent.toFixed(1)}%/${s.ctxWindowK}k`
		: "?%/?k";
	return (
		`↑${fmtTokens(s.up)} (${fmtTokens(s.upUncached)}) ↓${fmtTokens(s.down)}` +
		`   $${s.sessionCost.toFixed(2)}/$${Math.round(s.cost30d)}` +
		`   ${ctx}`
	);
}

// --- Box-draw primitives -----------------------------------------------------
// All take a borderFn and pad inner content to (width-4). Box width = `width`.

export function topBorder(width: number, borderFn: StyleFn): string {
	return borderFn("╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
}

export function bottomBorder(width: number, borderFn: StyleFn): string {
	return borderFn("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
}

export function junction(width: number, borderFn: StyleFn): string {
	return borderFn("├" + "─".repeat(Math.max(0, width - 2)) + "┤");
}

/** Content line: │ <padded inner> │ ; inner padded to width-4. */
export function contentLine(inner: string, width: number, borderFn: StyleFn): string {
	return borderFn("│") + " " + padTo(inner, width - 4) + " " + borderFn("│");
}

// --- BoxWidget ---------------------------------------------------------------

export interface BoxWidgetOpts {
	borderFn?: StyleFn;
	/** Optional prefix prepended to every emitted line. */
	prefix?: string;
}

/**
 * Self-drawing rounded bordered box around wrapped multiline content.
 * render(width) returns [] when content empty (hidden).
 */
export class BoxWidget implements Component {
	private getLines: () => string[];
	private borderFn: StyleFn;
	private prefix: string;

	constructor(getLines: () => string[], opts: BoxWidgetOpts = {}) {
		this.getLines = getLines;
		this.borderFn = opts.borderFn ?? ident;
		this.prefix = opts.prefix ?? "";
	}

	render(width: number): string[] {
		const boxWidth = width - this.prefix.length;
		const raw = this.getLines().filter((l) => l.length > 0);
		if (raw.length === 0) return [];

		const inner = boxWidth - 4;
		const wrapped: string[] = [];
		for (const l of raw) wrapped.push(...wrapToWidth(l, inner));
		if (wrapped.length === 0) return [];

		const out: string[] = [];
		out.push(this.prefix + topBorder(boxWidth, this.borderFn));
		for (const w of wrapped) out.push(this.prefix + contentLine(w, boxWidth, this.borderFn));
		out.push(this.prefix + bottomBorder(boxWidth, this.borderFn));
		return out;
	}

	invalidate(): void {}
	dispose(): void {}
}
