/**
 * load-files extension — load full file contents from directories into context.
 *
 * One-step flow:
 *   /load-files <@paths...>  -> reads files and appends a custom message
 *                               before the next user prompt
 *
 * The custom message content is the full file dump. A registered message
 * renderer shows only a summary in pi; the LLM still receives the full dump.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Rules {
	skip: string[];
	fullExtensions: string[];
	excludeFull: string[];
	largeFileShareOfTotal: number;
	maxFileBytes: number | null;
}

interface StagedFile {
	absPath: string;
	relPath: string;
	bytes: number;
	estTokens: number;
}

interface DumpSummary {
	roots: string[];
	fullFiles: { relPath: string; bytes: number; estTokens: number }[];
	treeFiles: { relPath: string; isFull: boolean }[];
	totalTokens: number;
	largeFile?: { relPath: string; estTokens: number };
	contextWindow?: number;
	usedTokens: number | null;
	freeTokens: number | null;
	pct: number | null;
}

// ---------------------------------------------------------------------------
// Config (defaults; config.json next to this file overrides)
// ---------------------------------------------------------------------------

const DEFAULT_RULES: Rules = {
	skip: ["**/.git/**", "**/.idea/**", "**/.junie/**", "**/.dart_tool/**", "**/build/**"],
	fullExtensions: [".dart", ".md", ".nix", ".ts", ".yaml"],
	excludeFull: ["**/*.mock.dart", "**/*.mocks.dart"],
	largeFileShareOfTotal: 0.3,
	maxFileBytes: null,
};

function loadRules(): Rules {
	const rules: Rules = { ...DEFAULT_RULES };
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const raw = readFileSync(join(here, "config.json"), "utf-8");
		const cfg = JSON.parse(raw) as Partial<Rules>;
		if (Array.isArray(cfg.skip)) rules.skip = cfg.skip;
		if (Array.isArray(cfg.fullExtensions)) {
			rules.fullExtensions = cfg.fullExtensions.map((e) => e.toLowerCase());
		}
		if (Array.isArray(cfg.excludeFull)) {
			rules.excludeFull = cfg.excludeFull;
		}
		if (typeof cfg.largeFileShareOfTotal === "number") {
			rules.largeFileShareOfTotal = cfg.largeFileShareOfTotal;
		}
		if (cfg.maxFileBytes === null || typeof cfg.maxFileBytes === "number") {
			rules.maxFileBytes = cfg.maxFileBytes;
		}
	} catch {
		// config.json optional; defaults already in place.
	}
	return rules;
}

// ---------------------------------------------------------------------------
// Glob matcher (minimatch-subset: supports **, *, ?, literals). Zero-dependency.
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
	const p = pattern.replace(/\\/g, "/");
	let re = "";
	let i = 0;
	while (i < p.length) {
		const c = p[i];
		if (c === "*" && p[i + 1] === "*") {
			i += 2;
			if (p[i] === "/") {
				i++; // globstar-dir: **/ matches zero or more leading segments
				re += "(?:.*/)?";
				continue;
			}
			re += ".*"; // bare ** matches anything including separators
			continue;
		}
		if (c === "*") {
			re += "[^/]*";
			i++;
			continue;
		}
		if (c === "?") {
			re += "[^/]";
			i++;
			continue;
		}
		if ("/.+^${}()|[]\\".includes(c)) {
			re += "\\" + c;
			i++;
			continue;
		}
		re += c;
		i++;
	}
	return new RegExp("^" + re + "$");
}

function compileSkip(skip: string[]): RegExp[] {
	return skip.map((g) => globToRegex(g));
}

function compileExcludeFull(excludeFull: string[]): RegExp[] {
	return excludeFull.map((g) => globToRegex(g));
}

function isSkipped(relPath: string, skipRegexes: RegExp[]): boolean {
	return skipRegexes.some((re) => re.test(relPath));
}

// ---------------------------------------------------------------------------
// Tree builder (deterministic, sorted)
// ---------------------------------------------------------------------------

interface TreeN {
	name: string;
	children: Map<string, TreeN>;
	file?: { relPath: string; isFull: boolean };
}

function buildTree(files: { relPath: string; isFull: boolean }[], theme?: { fg: (c: string, t: string) => string }): string {
	const root: TreeN = { name: "", children: new Map() };
	for (const f of files) {
		const parts = f.relPath.split("/");
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLeaf = i === parts.length - 1;
			let child = cur.children.get(part);
			if (!child) {
				child = { name: part, children: new Map() };
				cur.children.set(part, child);
			}
			if (isLeaf) child.file = f;
			cur = child;
		}
	}
	const lines: string[] = [];
	const render = (node: TreeN, indent: string) => {
		const kids = [...node.children.values()].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const child of kids) {
			const isDir = child.children.size > 0 && !child.file;
			if (isDir) {
				lines.push(`${indent}${child.name}/`);
				render(child, indent + "  ");
			} else if (child.file) {
				const mark = child.file.isFull && theme ? theme.fg("accent", " \u25cf") : "";
				lines.push(`${indent}${child.name}${mark}`);
			}
		}
	};
	render(root, "");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

function fmtNum(n: number): string {
	const s = Math.round(n).toString();
	return s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function fmtTokens(n: number): string {
	return `~${fmtNum(n)} tokens`;
}

function fmtPct(pct: number): string {
	return `${Math.round(pct)}`;
}

// ---------------------------------------------------------------------------
// Free-context computation
// ---------------------------------------------------------------------------

interface FreeCtx {
	contextWindow?: number;
	usedTokens: number | null;
	freeTokens: number | null;
}

function computeFree(ctx: {
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}): FreeCtx {
	const u = ctx.getContextUsage();
	if (!u) return { usedTokens: null, freeTokens: null };
	const used = u.tokens ?? 0;
	return { contextWindow: u.contextWindow, usedTokens: u.tokens, freeTokens: u.contextWindow - used };
}

// ---------------------------------------------------------------------------
// Path walking / staging
// ---------------------------------------------------------------------------

function toRel(cwd: string, absPath: string): string {
	return relative(cwd, absPath).replace(/\\/g, "/");
}

async function walkDir(
	dirAbs: string,
	cwd: string,
	fullExts: Set<string>,
	maxFileBytes: number | null,
	skipRegexes: RegExp[],
	excludeFullRegexes: RegExp[],
	fullFiles: StagedFile[],
	treeFiles: { relPath: string; isFull: boolean }[],
): Promise<string[]> {
	const errors: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dirAbs, { withFileTypes: true });
	} catch (err) {
		errors.push(`${toRel(cwd, dirAbs)}: ${(err as Error).message}`);
		return errors;
	}
	for (const ent of entries) {
		// Do not follow symlinks (avoid loops / external trees).
		if (ent.isSymbolicLink()) continue;
		const childAbs = join(dirAbs, ent.name);
		const rel = toRel(cwd, childAbs);
		if (isSkipped(rel, skipRegexes)) continue;
		if (ent.isDirectory()) {
			errors.push(...await walkDir(childAbs, cwd, fullExts, maxFileBytes, skipRegexes, excludeFullRegexes, fullFiles, treeFiles));
		} else if (ent.isFile()) {
			let st: import("node:fs").Stats;
			try {
				st = await stat(childAbs);
			} catch (err) {
				errors.push(`${rel}: ${(err as Error).message}`);
				continue;
			}
			const ext = extname(ent.name).toLowerCase();
			let isFull = fullExts.has(ext);
			if (isFull && excludeFullRegexes.some((re) => re.test(rel))) {
				isFull = false; // demote excluded-from-full files to tree-only
			}
			if (isFull && maxFileBytes != null && st.size > maxFileBytes) {
				isFull = false; // downgrade oversized file to tree-only
			}
			treeFiles.push({ relPath: rel, isFull });
			if (isFull) {
				fullFiles.push({
					absPath: childAbs,
					relPath: rel,
					bytes: st.size,
					estTokens: Math.ceil(st.size / 4),
				});
			}
		}
	}
	return errors;
}

function sortBuffers(
	fullFiles: StagedFile[],
	treeFiles: { relPath: string; isFull: boolean }[],
): void {
	const cmp = (a: { relPath: string }, b: { relPath: string }) =>
		a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
	fullFiles.sort(cmp);
	treeFiles.sort(cmp);
}

// ---------------------------------------------------------------------------
// Summary rendering (visible in TUI; LLM sees the raw dump instead)
// ---------------------------------------------------------------------------

function renderSummary(
	data: DumpSummary,
	expanded: boolean,
	theme: { fg: (c: string, t: string) => string },
): string[] {
	const lines: string[] = [];
	const pctTxt = data.pct == null ? "free context unknown" : `${fmtPct(data.pct)}% of free context`;
	lines.push(`${theme.fg("accent", "Loaded files")} ${fmtTokens(data.totalTokens)} (${pctTxt})`);
	lines.push(
		`${data.fullFiles.length} full-content / ${data.treeFiles.length - data.fullFiles.length} tree-only — roots: ${data.roots.join(", ")}`,
	);
	if (data.largeFile) {
		const largePct =
			data.freeTokens && data.freeTokens > 0
				? `${fmtPct((data.largeFile.estTokens / data.freeTokens) * 100)}% of free context`
				: "free context unknown";
		lines.push(`Large file: ${data.largeFile.relPath} @ ${fmtTokens(data.largeFile.estTokens)} (${largePct})`);
	}
	if (expanded && data.treeFiles.length > 0) {
		lines.push("");
		lines.push("");
		lines.push(`${theme.fg("muted", "\u25cf = full content loaded")}`);
		lines.push("");
		lines.push(buildTree(data.treeFiles, theme));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Dump builder
// ---------------------------------------------------------------------------

function fenceLang(relPath: string): string {
	return extname(relPath).toLowerCase().replace(/^\./, "");
}

function buildDump(
	roots: string[],
	fullFiles: StagedFile[],
	treeFiles: { relPath: string; isFull: boolean }[],
): { dump: string; unreadable: string[] } {
	const unreadable: string[] = [];
	const parts: string[] = [];
	parts.push(
		"The following files were loaded by the `/load-files` extension and injected in full as context before this prompt. They are not your own tool reads — the user loaded them up front so you can skip file-exploration loops. There is no need to read them again before you have made changes.",
	);
	parts.push("");
	parts.push(`Loaded roots: ${roots.join(", ")}`);
	parts.push(
		`Full-content files: ${fullFiles.length} (${fmtTokens(totalTokensOf(fullFiles))}). Tree-only (listed, no content): ${treeFiles.length - fullFiles.length}.`,
	);
	parts.push("");
	parts.push("Directory tree (`\u25cf` = content included below):");
	parts.push(buildTree(treeFiles) || "(empty)");
	parts.push("");
	parts.push("## File contents");
	parts.push("");
	for (const f of fullFiles) {
		let content: string;
		try {
			content = readFileSync(f.absPath, "utf-8");
		} catch (err) {
			unreadable.push(`${f.relPath}: ${(err as Error).message}`);
			continue;
		}
		const lang = fenceLang(f.relPath);
		const block = `### ${f.relPath}\n\`\`\`${lang}\n${content}${content.endsWith("\n") ? "" : "\n"}\`\`\``;
		parts.push(block);
		parts.push("");
	}
	if (unreadable.length > 0) {
		parts.push("> Note: some loaded files could not be read and were skipped:");
		for (const u of unreadable) parts.push(`> - ${u}`);
		parts.push("");
	}
	return { dump: parts.join("\n"), unreadable };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(args: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQ = false;
	for (let i = 0; i < args.length; i++) {
		const c = args[i];
		if (c === '"') {
			inQ = !inQ;
			continue;
		}
		if (/\s/.test(c) && !inQ) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
			continue;
		}
		cur += c;
	}
	if (cur) out.push(cur);
	return out;
}

function totalTokensOf(fullFiles: StagedFile[]): number {
	return fullFiles.reduce((sum, f) => sum + f.estTokens, 0);
}

function computeLargeFile(fullFiles: StagedFile[], totalTokens: number, share: number): StagedFile | null {
	if (fullFiles.length === 0 || totalTokens <= 0) return null;
	let largest: StagedFile | null = null;
	for (const f of fullFiles) {
		if (!largest || f.estTokens > largest.estTokens) largest = f;
	}
	if (!largest) return null;
	return largest.estTokens / totalTokens > share ? largest : null;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function loadFilesExtension(pi: ExtensionAPI): void {
	// Render a summary card in the TUI; the LLM still sees the full dump content.
	pi.registerMessageRenderer<DumpSummary>("load-files-dump", (message, { expanded, outputPad }, theme) => {
		const data = message.details ?? {
			roots: [],
			fullFiles: [],
			treeFiles: [],
			totalTokens: 0,
			usedTokens: null,
			freeTokens: null,
			pct: null,
		};
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		for (const line of renderSummary(data, expanded, theme)) {
			box.addChild(new Text(line, 0, 0));
		}
		return box;
	});

	// -- /load-files <@paths...> : load immediately --------------------------------
	pi.registerCommand("load-files", {
		description: "Load full file contents from @paths into context",
		handler: async (args, ctx) => {
			const rules = loadRules();
			const skipRegexes = compileSkip(rules.skip);
			const fullExts = new Set(rules.fullExtensions);
			const excludeFullRegexes = compileExcludeFull(rules.excludeFull);

			const trimmed = args.trim();
			if (trimmed === "") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /load-files <@paths...>", "info");
				return;
			}

			// Parse @paths (quote-aware). A leading @ is stripped (built-in tools do too).
			const rawTokens = parseArgs(trimmed);
			const paths: string[] = [];
			const bad: string[] = [];
			for (const tok of rawTokens) {
				const p = tok.startsWith("@") ? tok.slice(1) : tok;
				if (p === "") {
					bad.push(tok);
					continue;
				}
				paths.push(p);
			}

			const fullFiles: StagedFile[] = [];
			const treeFiles: { relPath: string; isFull: boolean }[] = [];
			const roots: string[] = [];
			for (const p of paths) {
				const abs = resolve(ctx.cwd, p);
				let st: import("node:fs").Stats;
				try {
					st = await stat(abs);
				} catch (err) {
					bad.push(`${p}: ${(err as Error).message}`);
					continue;
				}
				if (st.isFile()) {
					// Explicit file args are always full-included regardless of extension.
					const rel = toRel(ctx.cwd, abs);
					treeFiles.push({ relPath: rel, isFull: true });
					fullFiles.push({
						absPath: abs,
						relPath: rel,
						bytes: st.size,
						estTokens: Math.ceil(st.size / 4),
					});
					roots.push(rel);
				} else if (st.isDirectory()) {
					const errs = await walkDir(abs, ctx.cwd, fullExts, rules.maxFileBytes, skipRegexes, excludeFullRegexes, fullFiles, treeFiles);
					bad.push(...errs);
					roots.push(toRel(ctx.cwd, abs) || p);
				} else {
					bad.push(`${p}: not a file or directory`);
				}
			}

			sortBuffers(fullFiles, treeFiles);

			if (fullFiles.length === 0 && treeFiles.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`No files loaded.${bad.length > 0 ? " Problems: " + bad.join("; ") : ""}`,
						"error",
					);
				}
				return;
			}

			const totalTokens = totalTokensOf(fullFiles);
			const largeFile = computeLargeFile(fullFiles, totalTokens, rules.largeFileShareOfTotal);
			const free = computeFree(ctx);
			const pct = free.freeTokens && free.freeTokens > 0 ? (totalTokens / free.freeTokens) * 100 : null;

			const summary: DumpSummary = {
				roots,
				fullFiles: fullFiles.map((f) => ({ relPath: f.relPath, bytes: f.bytes, estTokens: f.estTokens })),
				treeFiles,
				totalTokens,
				largeFile: largeFile ? { relPath: largeFile.relPath, estTokens: largeFile.estTokens } : undefined,
				contextWindow: free.contextWindow,
				usedTokens: free.usedTokens,
				freeTokens: free.freeTokens,
				pct,
			};

			const { dump, unreadable } = buildDump(roots, fullFiles, treeFiles);

			pi.sendMessage<DumpSummary>(
				{
					customType: "load-files-dump",
					content: dump,
					display: true,
					details: summary,
				},
				{ triggerTurn: false },
			);

			if (ctx.hasUI) {
				let msg = `Loaded ${fullFiles.length} files (${fmtTokens(totalTokens)}).`;
				if (bad.length > 0) msg += ` ${bad.length} path problem(s): ${bad.join("; ")}`;
				if (unreadable.length > 0) msg += ` ${unreadable.length} unreadable file(s) skipped.`;
				ctx.ui.notify(msg, pct != null && pct > 100 ? "warning" : "info");
			} else if (bad.length > 0 || unreadable.length > 0) {
				ctx.ui.notify(
					`Loaded ${fullFiles.length} files. Problems: ${[...bad, ...unreadable].join("; ")}`,
					"warning",
				);
			}
		},
	});

}
