/**
 * Cost Tracker Extension (thin)
 *
 * Records per-message cost via cost-lib; emits plain integer 30d cost via
 * setStatus (default footer). Registers standalone /cost command.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { recordCost, get30dCost, get30dExact } from "./lib/cost-lib.ts";

const STATUS_KEY = "cost-tracker";

export default function (pi: ExtensionAPI) {
	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, String(get30dCost()));
	};

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const cost = event.message.usage?.cost?.total ?? 0;
		const modelId = event.message.model ?? ctx.model?.id ?? "unknown";
		if (cost > 0) {
			recordCost(modelId, cost);
			updateStatus(ctx);
		}
	});

	pi.registerCommand("cost", {
		description: "Show API cost over the last 30 days",
		handler: async (_args, ctx) => {
			const { total, models, days } = get30dExact();
			let msg = `30d Cost: $${total.toFixed(2)}`;

			let modelDetail = "";
			for (const [model, cost] of Object.entries(models).sort((a, b) => b[1] - a[1])) {
				if (cost > 0) modelDetail += `\n- ${model}: $${cost.toFixed(2)}`;
			}
			if (modelDetail) msg += `\n\nCost by model:${modelDetail}`;

			let detail = "";
			for (const day of days) {
				if (day.total > 0) {
					const dayModels = Object.entries(day.models)
						.filter(([_, c]) => c > 0)
						.map(([m, c]) => `${m}: $${c.toFixed(2)}`)
						.join(", ");
					detail += `\n${day.date}: $${day.total.toFixed(2)} (${dayModels})`;
				}
			}
			ctx.ui.notify(msg + (detail ? `\n\nDaily Breakdown:${detail}` : ""), "info");
		},
	});
}
