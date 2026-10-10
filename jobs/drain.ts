// jobs/drain.ts
//
// One-shot drain entry (jobs-line plan §2): the platform timer runs
//     node --env-file=.env jobs/drain.ts
// once per minute. One tick = schedule segment -> queued segment -> webhook
// delivery segment; the process exits after the tick, so every tick picks up
// the latest code with no reload machinery.
//
// Environment:
//   DATABASE_URL        required - the drain builds its own postgres.js client
//                       (the app's `$lib/server/db` reads `$env/dynamic/private`
//                       and cannot load under plain Node).
//   DATA_DIR            optional - jobs data dir (J-2; default <repo>/data).
//                       User job scripts and the generated SDK scaffold live
//                       in `$DATA_DIR/jobs`; the scaffold is refreshed on
//                       every tick (hash-guarded, a no-op when unchanged).
//   JOBS_HEARTBEAT_URL  optional - one GET after each tick (Uptime Kuma push
//                       style; the §25 monitoring line wires the actual probe).
//
// Exit codes: 0 = tick completed (individual job failures are recorded in
// `job_runs`, not in the exit code); 1 = the tick itself broke (segment
// errors, database unreachable); 2 = configuration error; 3 = the tick was
// aborted by a job timeout - the process exits HARD so the stuck job dies
// with it (the platform must alert on this too).

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runDrain, sanitizeErrorText } from '../src/lib/server/jobs/drain.ts';
import { resolveDataDir } from '../src/lib/server/jobs/data-dir.ts';
import { ensureJobsScaffold } from '../src/lib/server/jobs/scaffold.ts';
import { jobLockKey } from '../src/lib/server/jobs/registry.ts';
import { createJobLoader, resolveJobDefinition } from '../src/lib/server/jobs/user-layer.ts';
import type { DrainSummary } from '../src/lib/server/jobs/drain.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('[drain] DATABASE_URL is not set');
	process.exit(2);
}

const client = postgres(databaseUrl, { max: 5, onnotice: () => {} });
const db = drizzle(client);

async function tick(): Promise<DrainSummary> {
	// Session-level advisory locks must live on ONE connection for the whole
	// tick (plan §4.3) - reserve a connection instead of racing the pool.
	const lockConnection = await client.reserve();
	const acquireLock = async (job: string) => {
		const key = jobLockKey(job);
		const rows = await lockConnection`select pg_try_advisory_lock(hashtext(${key})) as ok`;
		if (rows[0]?.ok !== true) return null;
		return async () => {
			await lockConnection`select pg_advisory_unlock(hashtext(${key}))`;
		};
	};
	// Keep $DATA_DIR/jobs fresh before loading anything from it (J-2): the
	// scaffold is idempotent and self-healing, so a missing or stale data dir
	// is repaired here instead of failing the tick.
	const dataDir = resolveDataDir();
	try {
		// Scaffold failures degrade instead of killing the tick (J-2 review
		// F5): builtin schedules and webhook deliveries do not need the user
		// layer, and any user job that cannot load is recorded per run.
		try {
			await ensureJobsScaffold(dataDir);
		} catch (error) {
			console.error(
				`[drain] scaffold ensure failed (user jobs may not load this tick): ${sanitizeErrorText(error instanceof Error ? error.message : error)}`
			);
		}
		return await runDrain({
			db,
			acquireLock,
			loadJob: createJobLoader({ dataDir }),
			resolveJob: (name) => resolveJobDefinition(name, dataDir),
			heartbeatUrl: process.env.JOBS_HEARTBEAT_URL ?? null,
			log: (line) => console.log(line)
		});
	} finally {
		await lockConnection.release();
	}
}

async function runTick(): Promise<number> {
	let summary: DrainSummary;
	try {
		summary = await tick();
	} catch (err) {
		// The tick failure may embed the DATABASE_URL (connect/parse errors):
		// sanitize before it reaches journald.
		console.error(
			`[drain] tick failed: ${sanitizeErrorText(err instanceof Error ? err.message : err)}`
		);
		await client.end({ timeout: 5 });
		return 1;
	}
	if (summary.aborted) {
		// A timed-out job is still running inside this process; only process
		// death stops it, so skip the graceful teardown on purpose.
		console.error('[drain] tick aborted by a job timeout - hard exit kills the stuck job');
		return 3;
	}
	await client.end({ timeout: 5 });
	return summary.segmentErrors.length > 0 ? 1 : 0;
}

const exitCode = await runTick();
if (exitCode === 3) {
	// Hard exit: bypasses pool teardown / pending timers held by the stuck job.
	process.exit(3);
}
process.exitCode = exitCode;
