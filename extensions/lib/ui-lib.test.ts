/**
 * ui-lib.test - unit tests for pure UI helpers.
 *
 * Intentions:
 * - fitBorder: right-first truncation, minimumGap, wide-char width, exact total width.
 * - wrapToWidth: word boundaries, long-word hard-split, empty.
 * - formatStats: token formatting, NO cache-hit %, $session/$30d, ctx, NO duration.
 * - BoxWidget.render: exact width, empty->[], multiline wrap, border chars.
 * Run: node --test (with NODE_PATH to package's nested node_modules).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	fitBorder,
	wrapToWidth,
	formatStats,
	formatTurnSummary,
	fmtTokens,
	abbreviateThinking,
	BoxWidget,
	type StatsData,
	type TurnSummaryData,
} from "./ui-lib.ts";

const id = (s: string) => s;

test("fitBorder exact total width", () => {
	const out = fitBorder("ab", "cd", 20, id);
	assert.equal(visibleWidth(out), 20);
});

test("fitBorder truncates right first", () => {
	const out = fitBorder("LEFT", "RIGHTSIDE", 12, id);
	assert.ok(out.includes("LEFT"), "left preserved");
	assert.ok(!out.includes("RIGHTSIDE"), "right truncated");
	assert.equal(visibleWidth(out), 12);
});

test("fitBorder degenerate widths", () => {
	assert.equal(fitBorder("a", "b", 0, id), "");
	assert.equal(fitBorder("a", "b", 1, id), "─");
});

test("wrapToWidth word boundaries", () => {
	assert.deepEqual(wrapToWidth("aa bb cc", 5), ["aa bb", "cc"]);
});

test("wrapToWidth hard-splits long word", () => {
	const out = wrapToWidth("abcdefgh", 3);
	assert.ok(out.every((l) => visibleWidth(l) <= 3));
	assert.equal(out.join(""), "abcdefgh");
});

test("wrapToWidth empty", () => {
	assert.deepEqual(wrapToWidth("", 5), [""]);
});

test("fmtTokens integer mantissa, no decimals", () => {
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "2k");
	assert.equal(fmtTokens(125000), "125k");
});

test("abbreviateThinking maps to clothing sizes", () => {
	assert.equal(abbreviateThinking("off"), "off");
	assert.equal(abbreviateThinking("minimal"), "xs");
	assert.equal(abbreviateThinking("low"), "s");
	assert.equal(abbreviateThinking("medium"), "m");
	assert.equal(abbreviateThinking("high"), "l");
	assert.equal(abbreviateThinking("xhigh"), "xl");
});

test("formatStats no cache-hit %, has $session/$30d, ctx, no duration", () => {
	const s: StatsData = {
		up: 125000, upUncached: 3000, down: 12000, sessionCost: 2.68, cost30d: 14,
		ctxPercent: 87, ctxWindowK: 200,
	};
	const out = formatStats(s);
	assert.ok(!out.includes("CH"), "no cache-hit label");
	assert.ok(out.includes("↑125k (3k)"), "input shows total (uncached)");
	assert.ok(out.includes("↓12k"));
	assert.ok(out.includes("$2.68/$14"));
	assert.ok(out.includes("87.0%/200k"));
	assert.ok(!out.includes("⏱"), "no duration in stats line");
});

test("formatStats unknown ctx", () => {
	const out = formatStats({
		up: 0, upUncached: 0, down: 0, sessionCost: 0, cost30d: 0,
		ctxPercent: null, ctxWindowK: null,
	});
	assert.ok(out.includes("?%/?k"));
});

test("formatTurnSummary compact row with k-shortening and whole-second rounding", () => {
	const summary: TurnSummaryData = {
		up: 125000,
		upUncached: 3400,
		down: 9200,
		cost: 2.68,
		durationMs: 12345,
	};
	const out = formatTurnSummary(summary);
	assert.equal(out, "↑ 125k (3k) ↓ 9k │ $2.68 │ ⏱ 12s");
});

test("formatTurnSummary pads to exact width when requested", () => {
	const summary: TurnSummaryData = {
		up: 500,
		upUncached: 200,
		down: 600,
		cost: 0.13,
		durationMs: 1500,
	};
	const out = formatTurnSummary(summary, 40);
	assert.equal(visibleWidth(out), 40);
	assert.ok(out.startsWith("↑ 500 (200)"));
});

test("BoxWidget empty -> []", () => {
	const w = new BoxWidget(() => []);
	assert.deepEqual(w.render(40), []);
});

test("BoxWidget exact width + border chars + wrap", () => {
	const w = new BoxWidget(() => ["hello world foo bar baz qux"]);
	const lines = w.render(20);
	assert.ok(lines.length >= 3);
	assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
	assert.ok(lines[lines.length - 1].startsWith("╰"));
	for (const l of lines) assert.equal(visibleWidth(l), 20);
});

test("BoxWidget prefix margin", () => {
	const w = new BoxWidget(() => ["x"], { prefix: " " });
	const lines = w.render(20);
	for (const l of lines) {
		assert.ok(l.startsWith(" "));
		assert.equal(visibleWidth(l), 20);
	}
});
