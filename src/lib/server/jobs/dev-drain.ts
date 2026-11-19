// Dev-only background drain: this module holds the tick and the loop behind
// `pnpm ops jobs dev`, so the entry (`jobs/dev.ts`) stays a thin wrapper around the
// same `runDrain` the production timer uses.
//
// Production runs `jobs/drain.ts` from `deploy/systemd/web-lair-drain.timer`
// once a minute; `vite dev` has no such timer, so an enqueue-only action waits
// at `queued` forever until someone runs the drain by hand (README, "Background
// jobs in development").
//
// Node-type-strippable on purpose (explicit `.ts` extensions, no aliases, no
// SvelteKit virtual modules) so it loads under `node jobs/dev.ts`, exactly like
// `jobs/drain.ts`.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runDrain } from './drain.ts';
import { createNotificationSink } from '../notifications/outbox.ts';
import { setNotificationSink } from '../notifications/notify.ts';
import { createIntervalLoop } from './drain-loop.ts';
import type { IntervalLoop } from './drain-loop.ts';
import { resolveDataDir } from './data-dir.ts';
import { ensureJobsScaffold } from './scaffold.ts';
import { jobLockKey } from './registry.ts';
import { createJobLoader, resolveJobDefinition } from './user-layer.ts';

/**
 * 3s: the translation drawer polls the candidate every 2s, so a click must
 * reach a claim within roughly one poll. A tick is three cheap queries plus
 * whatever job is queued; running it more often only adds log noise.
 */
export const DEV_DRAIN_INTERVAL_MS = 3_000;

export interface DevDrain {
	loop: IntervalLoop;
	/** Stops the loop and releases the drain's own connection pool. */
	stop(): Promise<void>;
}

/**
 * Start the dev drain. Returns null when there is no database to drain, so a
 * half-configured checkout reports one line instead of crashing.
 */
export function startDevDrain(options: {
	databaseUrl: string | undefined;
	intervalMs?: number;
	log?: (line: string) => void;
}): DevDrain | null {
	const { databaseUrl, intervalMs = DEV_DRAIN_INTERVAL_MS, log = console.log } = options;
	if (!databaseUrl) {
		console.warn('[dev-drain] DATABASE_URL is not set; background jobs will not run');
		return null;
	}
	const client = postgres(databaseUrl, { max: 3, onnotice: () => {} });
	const db = drizzle(client);
	// Probes alert through `notify()`; in development this process is the only
	// drain, so it installs the outbox sink (one per process).
	setNotificationSink(createNotificationSink(db));
	const dataDir = resolveDataDir();

	async function tick(): Promise<void> {
		// Session advisory locks live on ONE connection for the whole tick, so it
		// is reserved instead of borrowed from the pool (same contract as
		// `jobs/drain.ts`, which keeps it for the process lifetime).
		const lockConnection = await client.reserve();
		const acquireLock = async (job: string) => {
			const key = jobLockKey(job);
			const rows = await lockConnection`select pg_try_advisory_lock(hashtext(${key})) as ok`;
			if (rows[0]?.ok !== true) return null;
			return async () => {
				await lockConnection`select pg_advisory_unlock(hashtext(${key}))`;
			};
		};
		try {
			const loader = createJobLoader({ dataDir });
			// The scaffold is what makes user jobs loadable; a failure must not
			// stop builtin schedules or the queue from draining.
			try {
				await ensureJobsScaffold(dataDir);
			} catch (error) {
				console.warn(
					`[dev-drain] scaffold ensure failed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			const summary = await runDrain({
				db,
				acquireLock,
				loadJob: loader,
				resolveJob: (name) => resolveJobDefinition(name, dataDir),
				// No heartbeat ping in development: JOBS_HEARTBEAT_URL points at the
				// production uptime probe and a dev machine must not feed it.
				heartbeatUrl: null,
				// A tick every few seconds would print its own summary forever; the
				// lines that report work and errors still go through, and the loop
				// prints one compact line below when a tick did something.
				log: (line) => {
					if (!line.startsWith('[drain] tick done:')) log(line);
				}
			});
			const worked =
				summary.schedules.fired > 0 ||
				summary.schedules.errors > 0 ||
				summary.queue.claimed > 0 ||
				summary.queue.errors > 0 ||
				summary.deliveries.sent > 0 ||
				summary.deliveries.failed > 0 ||
				summary.segmentErrors.length > 0;
			// Silence is the healthy idle state.
			if (worked) {
				log(
					`[dev-drain] tick: fired ${summary.schedules.fired}, claimed ${summary.queue.claimed}, delivered ${summary.deliveries.sent}`
				);
			}
		} finally {
			await lockConnection.release();
		}
	}

	const loop = createIntervalLoop({
		run: tick,
		intervalMs,
		log: (line) => console.warn(line)
	});
	loop.start();

	return {
		loop,
		async stop() {
			loop.stop();
			await client.end({ timeout: 5 });
		}
	};
}
