/**
 * Prompt Duration Extension (thin)
 *
 * Drives duration-lib timer; emits plain time string via setStatus.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { start, stop, getDurationStr } from "./lib/duration-lib.ts";

const STATUS_KEY = "prompt-duration";
const TICK_MS = 300;

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;

	const show = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, getDurationStr());
	};

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		show(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		stopTimer();
		start();
		show(ctx);
		timer = setInterval(() => show(ctx), TICK_MS);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer();
		stop();
		show(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});
}
