export interface ParsedItem {
	type: "question";
	num: number;
	id: string; // "Q1", etc.
	text: string;
}

/**
 * Parses assistant text for sequential bullet points under `## Questions`.
 * Supports "N." and "N)" formats and multi-line bullet points.
 *
 * A blank line terminates the current multi-line bullet block so trailing prose
 * after the list does not leak into the last item's text.
 */
export function parseQuestions(text: string): ParsedItem[] {
	const lines = text.split("\n");
	const items: ParsedItem[] = [];

	let inSection = false;
	let currentItem: ParsedItem | null = null;

	const flushCurrent = () => {
		if (currentItem) {
			currentItem.text = currentItem.text.trim();
			if (currentItem.text) {
				items.push(currentItem);
			}
			currentItem = null;
		}
	};

	for (const line of lines) {
		const trimmedLine = line.trim();

		// Detect the questions section.
		if (/^##\s+Questions\s*$/i.test(trimmedLine)) {
			flushCurrent();
			inSection = true;
			continue;
		}

		// Any other heading terminates the current parsing context.
		if (/^#+\s+/.test(trimmedLine)) {
			flushCurrent();
			inSection = false;
			continue;
		}

		if (!inSection) {
			continue;
		}

		// A blank line terminates the current multi-line bullet block.
		if (trimmedLine === "") {
			flushCurrent();
			continue;
		}

		// Look for items: N. or N) at start of line.
		const itemMatch = line.match(/^(\s*)(\d+)[.)]\s*(.*)$/);
		if (itemMatch) {
			flushCurrent();
			const num = parseInt(itemMatch[2], 10);
			const textStart = itemMatch[3];

			currentItem = {
				type: "question",
				num,
				id: `Q${num}`,
				text: textStart,
			};
		} else if (currentItem) {
			// Append continuation line to the active bullet.
			currentItem.text += "\n" + line;
		}
	}

	flushCurrent();
	return items;
}
