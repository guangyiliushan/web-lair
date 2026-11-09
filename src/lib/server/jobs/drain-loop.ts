/**
 * Serial loop for one-shot drain ticks.
 *
 * The production drain is cron-like: the platform timer starts
 * `jobs/drain.ts`, one tick runs, the process exits. Development has no timer,
 * so the same tick has to be driven from inside the dev server - and there the
 * loop must never overlap itself (two concurrent ticks claim-fight over the
 * same rows) and must not keep the process alive once it is stopped.
 *
 * Kept dependency-free on purpose: the dev drain imports it next to `$env` and
 * a database client, so the scheduling rules stay testable on their own.
 */

export interface IntervalLoop {
	/** Run once immediately, then every `intervalMs` after each run settles. */
	start(): void;
	/** Cancel the pending run and stop scheduling; an in-flight one finishes. */
	stop(): void;
	/** True between `start()` and `stop()`. */
	readonly active: boolean;
}

export function createIntervalLoop(options: {
	run: () => Promise<void>;
	intervalMs: number;
	log: (line: string) => void;
}): IntervalLoop {
	const { run, intervalMs, log } = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = false;

	async function tick(): Promise<void> {
		if (!active) return;
		try {
			await run();
		} catch (error) {
			// A failed tick is not a reason to stop draining: the next one picks up
			// whatever is still queued.
			log(`[dev-drain] tick failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// `stop()` may have landed while the run was in flight.
		if (!active) return;
		timer = setTimeout(() => void tick(), intervalMs);
		// Never hold the dev server's event loop open.
		timer.unref?.();
	}

	return {
		start() {
			if (active) return;
			active = true;
			void tick();
		},
		stop() {
			active = false;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		get active() {
			return active;
		}
	};
}
