/**
 * duration-lib - latest-prompt timer singleton (no UI).
 */

let startTime = 0;
let endTime = 0;
let running = false;

export function start(): void {
	startTime = Date.now();
	endTime = 0;
	running = true;
}

export function stop(): void {
	if (running) {
		endTime = Date.now();
		running = false;
	}
}

export function getDurationMs(): number {
	if (!startTime) return 0;
	return (running ? Date.now() : endTime) - startTime;
}

export function fmt(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${m}m${rem.toString().padStart(2, "0")}s`;
}

export function getDurationStr(): string {
	return fmt(getDurationMs());
}
