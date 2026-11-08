/**
 * cost-lib - cost storage/compute singleton (no UI).
 *
 * Persists daily + per-model cost in /root/.pi/agent/cost_history.json.
 * recordCost / get30dCost / get30dByModel.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const STORAGE_PATH = "/root/.pi/agent/cost_history.json";

interface DayRecord {
	total: number;
	models: { [modelId: string]: number };
}

interface CostHistory {
	[date: string]: DayRecord | number;
}

function loadHistory(): CostHistory {
	try {
		if (fs.existsSync(STORAGE_PATH)) {
			return JSON.parse(fs.readFileSync(STORAGE_PATH, "utf8"));
		}
	} catch {}
	return {};
}

function saveHistory(history: CostHistory) {
	try {
		const dir = path.dirname(STORAGE_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(STORAGE_PATH, JSON.stringify(history, null, 2), "utf8");
	} catch {}
}

function getRecord(dayData: DayRecord | number | undefined): DayRecord {
	if (!dayData) return { total: 0, models: {} };
	if (typeof dayData === "number") return { total: dayData, models: { unknown: dayData } };
	return { total: dayData.total ?? 0, models: dayData.models ?? {} };
}

function pruneHistory(history: CostHistory): CostHistory {
	const clean: CostHistory = {};
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
		.toISOString().split("T")[0];
	for (const date of Object.keys(history)) {
		if (date >= cutoff) clean[date] = history[date];
	}
	return clean;
}

/** Record a cost amount for a model on today's date. */
export function recordCost(modelId: string, amount: number): void {
	if (!(amount > 0)) return;
	const today = new Date().toISOString().split("T")[0];
	let history = loadHistory();
	const record = getRecord(history[today]);
	record.total += amount;
	record.models[modelId] = (record.models[modelId] ?? 0) + amount;
	history[today] = record;
	history = pruneHistory(history);
	saveHistory(history);
}

/** Total cost over last 30 days, rounded to int. */
export function get30dCost(): number {
	return Math.round(get30dExact().total);
}

/** Exact (unrounded) 30d total + per-model + per-day breakdowns. */
export function get30dExact(): {
	total: number;
	models: { [modelId: string]: number };
	days: { date: string; total: number; models: { [m: string]: number } }[];
} {
	const history = loadHistory();
	let total = 0;
	const models: { [modelId: string]: number } = {};
	const days: { date: string; total: number; models: { [m: string]: number } }[] = [];
	const now = new Date();
	for (let i = 0; i < 30; i++) {
		const dateStr = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
			.toISOString().split("T")[0];
		const record = getRecord(history[dateStr]);
		total += record.total;
		for (const [m, c] of Object.entries(record.models)) {
			models[m] = (models[m] ?? 0) + c;
		}
		days.push({ date: dateStr, total: record.total, models: record.models });
	}
	return { total, models, days };
}
