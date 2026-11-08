import type { AssistantMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { parseQuestions } from "./parser.ts";

interface AnswerState {
	itemId: string; // e.g., "Q1", "Q2"
	answer: string;
}

export default function answerPlanExtension(pi: ExtensionAPI): void {
	// Visible rendering for each answer echoed into the session.
	pi.registerMessageRenderer("answer-plan-answer", (message, _options, theme) => {
		return new Text(`${theme.fg("accent", "\u2713 Answer")} ${message.content}`, 0, 0);
	});

	pi.registerCommand("answer", {
		description: "Interactively answer questions from the last plan turn",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/answer requires interactive mode", "error");
				return;
			}

			// 1. Find last user message, and accumulate subsequent assistant text content
			const branch = ctx.sessionManager.getBranch();
			let lastUserIndex = -1;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message.role === "user") {
					lastUserIndex = i;
					break;
				}
			}

			let combinedAssistantText = "";
			for (let i = lastUserIndex + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const msg = entry.message as AssistantMessage;
					const text = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
					if (text) {
						combinedAssistantText += (combinedAssistantText ? "\n" : "") + text;
					}
				}
			}

			if (!combinedAssistantText) {
				ctx.ui.notify("No plan questions found (no assistant messages since last user prompt)", "error");
				return;
			}

			// 2. Parse questions
			const parsedItems = parseQuestions(combinedAssistantText);
			if (parsedItems.length === 0) {
				ctx.ui.notify("No questions found in last message", "warning");
				return;
			}

			// 3. Load existing answers from the session entries.
			// IMPORTANT: only scan entries *after* lastUserIndex (i.e. the current
			// turn). Each turn reuses the same item IDs (Q1, Q2, …), so including
			// stale entries from prior turns would falsely mark this turn's items
			// as already-answered and skip them. Entries appended during an
			// in-progress /answer session are always at the end of the branch
			// (after lastUserIndex), so intra-turn resume still works correctly.
			const answeredMap = new Map<string, string>();
			for (let i = lastUserIndex + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry.type === "custom" && entry.customType === "answer-plan-state") {
					const state = entry.data as AnswerState;
					if (state && state.itemId && state.answer) {
						answeredMap.set(state.itemId, state.answer);
					}
				}
			}

			// 4. Interactively ask each unanswered item
			let stopped = false;
			for (const item of parsedItems) {
				if (answeredMap.has(item.id)) {
					continue; // Already answered
				}

				// Render question above input. Item text is rendered as markdown
				// so inline markers (bold, code) are styled instead of shown raw.
				ctx.ui.setWidget("answer-prompt", (_tui, theme) => {
					const container = new Container();
					container.addChild(new Text(theme.fg("accent", `[Question ${item.num}/${parsedItems.length}]`), 0, 0));
					container.addChild(new Markdown(item.text, 1, 0, getMarkdownTheme()));
					container.addChild(new Text(theme.fg("dim", "Empty answer = skip. Press Esc to stop."), 0, 0));
					return container;
				});

				const promptMsg = `Answer (empty = skip): `;
				const inputVal = await ctx.ui.input(promptMsg);

				// Esc / Ctrl+C cancels the input and stops the loop.
				if (inputVal === undefined) {
					stopped = true;
					break;
				}

				const trimmed = inputVal.trim();

				// Empty answer = skip this item.
				if (trimmed === "") {
					continue;
				}

				// Persist state for resume (not in LLM context).
				pi.appendEntry("answer-plan-state", {
					itemId: item.id,
					answer: trimmed,
				} as AnswerState);
				answeredMap.set(item.id, trimmed);

				// Echo the answer into the session so it is visible in the TUI
				// and included in the agent context on the next turn.
				pi.sendMessage({
					customType: "answer-plan-answer",
					content: `${item.id}: ${trimmed}`,
					display: true,
					details: { itemId: item.id, answer: trimmed },
				});
			}

			// Clear widget
			ctx.ui.setWidget("answer-prompt", undefined);

			if (stopped) {
				ctx.ui.notify("Answering paused. Progress saved.", "info");
				return;
			}

			// 5. Free-form notes prompt
			ctx.ui.setWidget("answer-prompt", [
				ctx.ui.theme.fg("accent", "[Optional Notes]"),
				"  Enter any additional notes or instructions for the agent.",
			]);

			// Reminder appended to every /answer turn: restate the plan-skill
			// interview loop and force the agent to resurface lost items.
			const planReminder =
				"\n\n---\n" +
				"Reminder — continue the /plan interview loop: surface up to 3 prioritized `## Questions` " +
				"(blockers first); never assume a silent default — every unspecified choice is a question. ";

			const notesVal = await ctx.ui.input("Notes (or Enter to submit): ");
			ctx.ui.setWidget("answer-prompt", undefined);

			if (notesVal === undefined) {
				ctx.ui.notify("Answering cancelled. Progress saved.", "info");
				return;
			}

			// 6. Answers were already echoed into the session context above.
			// The final user message only carries optional notes and triggers the turn.
			const notesTrimmed = notesVal.trim();
			const hasAnswers = parsedItems.some((item) => answeredMap.has(item.id));

			if (!hasAnswers && !notesTrimmed) {
				ctx.ui.notify("No answers or notes to send.", "warning");
				return;
			}

			const baseMessage = notesTrimmed
				? notesTrimmed
				: "Answers provided above. Please continue with the plan.";
			await pi.sendUserMessage(baseMessage + planReminder);
		},
	});
}

