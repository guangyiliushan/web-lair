// scripts/verify-jobs-drain.ts
//
// Acceptance harness for the J-1 drain kernel (jobs-line plan §7 assertions).
//
//   pnpm db:verify-jobs
//
// Runs entirely against a THROWAWAY database: it creates `wl_jobs_verify_*`
// on the server DATABASE_URL points at, applies the baseline migration, seeds
// fixtures, spawns real `node jobs/drain.ts` processes (including one that is
// SIGKILLed mid-flight), and drops the database afterwards. The live database
// is never written to.
//
// Covered: T1 (concurrent double drain -> CAS exactly-one), T2 (queued unique,
// 23505 idempotent), T3 (stale reclamation + its order contract, queue AND
// schedule paths), T4 (catch-up runs the most recent due only), T5 (lock held
// -> no watermark move, no reclaim, next tick catches up), T9 (kill a
// lock-holding process -> reclaim + queued rows survive; kill a real drain
// mid-delivery -> the delivery row stays queued), webhook signing/410
// semantics, 3xx-is-failure (redirect never followed), unreachable-endpoint
// network failures, jobs.prune retention, source_hash records the executing
// file, bootstrap of a NULL watermark, a microsecond-precision watermark
// written by SQL (monotonic CAS), the executeRun failure branch (poisoned
// table), concurrent delivery and queue claims, the entry exit-code contract
// (2 / 1), heartbeat ping; since J-2: T6 (SDK dual resolution), T7 (save
// gate negatives) and T10 (user jobs end-to-end: hot update, fork override,
// run-scoped SDK binding), T11 (delete lifecycle on a real database), T12
// (admin edit mid-tick -> config-snapshot CAS; toggle race on a real DB) and
// the scaffold-degradation guard. T8 (Kuma wiring) to §25.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { asc, eq } from 'drizzle-orm';
import postgres, { type ReservedSql } from 'postgres';
import { activities } from '../src/lib/server/db/system/activity.schema';
import { jobRuns } from '../src/lib/server/db/system/job-run.schema';
import { jobSchedules } from '../src/lib/server/db/system/job-schedule.schema';
import { webhookDeliveries } from '../src/lib/server/db/system/webhook-delivery.schema';
import { webhooks } from '../src/lib/server/db/system/webhook.schema';
import { enqueueJob } from '../src/lib/server/jobs/queue';
import { deleteUserJob } from '../src/lib/server/jobs/job-scripts';
import { toggleSchedule } from '../src/lib/server/jobs/job-schedules';
import { builtinModuleFile, jobLockKey } from '../src/lib/server/jobs/registry';
import { signWebhookPayload } from '../src/lib/server/jobs/signature';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureJobsScaffold } from '../src/lib/server/jobs/scaffold';
import { runSaveGate } from '../src/lib/server/jobs/save-gate';
import { runJobsTypecheck } from '../src/lib/server/jobs/typecheck';
import { resolveJobDefinition } from '../src/lib/server/jobs/user-layer';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Throwaway DATA_DIR for every drain spawn (J-2): the entry scaffolds and
 * loads user jobs from `$DATA_DIR/jobs`, so the harness pins it here instead
 * of the repo's `data/`, and removes it in the teardown.
 */
const fixtureDataDir = await mkdtemp(join(tmpdir(), 'wl-jobs-verify-data-'));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let checks = 0;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
	checks += 1;
	if (ok) {
		console.log(`  ok   ${name}`);
	} else {
		failures += 1;
		console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
	}
}

function section(title: string): void {
	console.log(`\n== ${title}`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('DATABASE_URL is required (run via `pnpm db:verify-jobs`).');
	process.exit(1);
}
const scratchName = `wl_jobs_verify_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
if (!scratchName.startsWith('wl_jobs_verify_')) throw new Error('scratch name guard');

// Derive the scratch/admin URLs safely: DATABASE_URL must name a database in
// its path, and the derivation is verified to still point at the same host on
// the same server BEFORE any statement runs - a silent failure-open here would
// point the TRUNCATE and every fixture write at the LIVE database.
const parsedDatabaseUrl = new URL(databaseUrl);
if (!parsedDatabaseUrl.pathname || parsedDatabaseUrl.pathname === '/') {
	throw new Error('DATABASE_URL must include a database name in its path');
}
const withDatabase = (name: string) => {
	// Rebuild through the URL parser: a plain string replace can hit the
	// database name inside the userinfo and still "succeed" at pointing at
	// the same database.
	const derived = new URL(databaseUrl);
	derived.pathname = `/${name}`;
	return derived.toString();
};
const adminUrl = withDatabase('postgres');
const scratchUrl = withDatabase(scratchName);
{
	const parsedScratch = new URL(scratchUrl);
	if (
		scratchUrl === databaseUrl ||
		parsedScratch.hostname !== parsedDatabaseUrl.hostname ||
		parsedScratch.pathname !== `/${scratchName}`
	) {
		throw new Error(
			'refusing to run: scratch URL derivation did not produce a distinct database on the same host'
		);
	}
}

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const client = postgres(scratchUrl, { max: 6, onnotice: () => {} });
const db = drizzle(client);

async function resetLedger(): Promise<void> {
	await client.unsafe(
		'truncate table job_runs, job_schedules, webhook_deliveries, webhooks, activities'
	);
}

// ---------------------------------------------------------------------------
// Drain process + fixture helpers
// ---------------------------------------------------------------------------

interface DrainResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Children spawned by this harness; the teardown kills whatever survived. */
const spawnedChildren = new Set<ChildProcess>();

function spawnDrain(extraEnv: Record<string, string> = {}): {
	child: ChildProcess;
	done: Promise<DrainResult>;
} {
	const env = { ...process.env };
	// Never let the real push-monitor URL leak into fixture drains (the .env
	// this script runs with may carry it); the heartbeat scenario passes an
	// explicit local URL back in.
	delete env.JOBS_HEARTBEAT_URL;
	const child = spawn(process.execPath, ['jobs/drain.ts'], {
		cwd: repoRoot,
		env: { ...env, DATABASE_URL: scratchUrl, DATA_DIR: fixtureDataDir, ...extraEnv }
	});
	spawnedChildren.add(child);
	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
	const done = new Promise<DrainResult>((resolve) => {
		child.on('close', (code) => {
			spawnedChildren.delete(child);
			resolve({ code, stdout, stderr });
		});
	});
	return { child, done };
}

async function runDrainOnce(extraEnv: Record<string, string> = {}): Promise<DrainResult> {
	const result = await spawnDrain(extraEnv).done;
	if (result.code !== 0) {
		console.log(`  (drain exited ${result.code})\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

/**
 * A process that holds the job's session advisory lock (and optionally a
 * `running` ledger row) - exactly the state a killed drain leaves behind.
 * Written with plain SQL on a reserved connection; SIGKILLed by the caller
 * where the scenario calls for it.
 */
function startLockHolder(
	job: string,
	withRunningRow: boolean
): { child: ChildProcess; ready: Promise<void> } {
	const script = `
		import postgres from 'postgres';
		const sql = postgres(process.env.WL_FIXTURE_DB_URL, { max: 1, onnotice: () => {} });
		const conn = await sql.reserve();
		const key = process.env.WL_FIXTURE_LOCK_KEY;
		const [lock] = await conn\`select pg_try_advisory_lock(hashtext(\${key})) as ok\`;
		if (!lock.ok) { console.log('LOCK-FAILED'); process.exit(3); }
		let rowId = '';
		if (process.env.WL_FIXTURE_RUNNING_ROW === '1') {
			const [row] = await conn\`insert into job_runs (job, trigger, status, started_at, source_hash)
				values (\${process.env.WL_FIXTURE_JOB}, 'cli', 'running', now(), 'fixture') returning id\`;
			rowId = row.id;
		}
		console.log('READY ' + rowId);
		setInterval(() => {}, 1000);
	`;
	const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
		cwd: repoRoot,
		env: {
			...process.env,
			WL_FIXTURE_DB_URL: scratchUrl,
			WL_FIXTURE_LOCK_KEY: jobLockKey(job),
			WL_FIXTURE_JOB: job,
			WL_FIXTURE_RUNNING_ROW: withRunningRow ? '1' : '0'
		}
	});
	const ready = new Promise<void>((resolve, reject) => {
		let buffer = '';
		const timer = setTimeout(() => reject(new Error('lock holder did not become ready')), 15000);
		child.stdout?.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			if (buffer.includes('READY')) {
				clearTimeout(timer);
				resolve();
			}
			if (buffer.includes('LOCK-FAILED')) {
				clearTimeout(timer);
				reject(new Error('lock holder could not take the lock (held elsewhere?)'));
			}
		});
		child.on('exit', () => {
			clearTimeout(timer);
			reject(new Error('lock holder exited before READY'));
		});
	});
	return { child, ready };
}

async function killProcess(child: ChildProcess): Promise<void> {
	const ended = new Promise<void>((resolve) => child.on('close', () => resolve()));
	child.kill('SIGKILL');
	await Promise.race([ended, delay(5000)]);
}

// A dedicated connection for lock probes: advisory locks are per-session, so
// try/unlock must never hop across pool connections. Lazily reserved - the
// scratch database does not exist until main() creates it. (Holder object: TS
// flow analysis would narrow a module-level `let` to null inside closures.)
const lockProbeRef: { current: ReservedSql | null } = { current: null };

async function lockProbeConnection(): Promise<ReservedSql> {
	if (!lockProbeRef.current) lockProbeRef.current = await client.reserve();
	return lockProbeRef.current;
}

async function waitUntilLockFree(job: string, timeoutMs = 10_000): Promise<boolean> {
	const key = jobLockKey(job);
	const probe = await lockProbeConnection();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = await probe`select pg_try_advisory_lock(hashtext(${key})) as ok`;
		if (rows[0]?.ok === true) {
			await probe`select pg_advisory_unlock(hashtext(${key}))`;
			return true;
		}
		await delay(100);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Webhook fixture server
// ---------------------------------------------------------------------------

interface CapturedRequest {
	path: string;
	method: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

let stallDeliveries = true;
const captured: CapturedRequest[] = [];
const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
	let body = '';
	request.on('data', (chunk: Buffer) => (body += chunk.toString()));
	request.on('end', () => {
		const path = request.url ?? '';
		captured.push({ path, method: request.method ?? '', headers: request.headers, body });
		if (path.startsWith('/stall') && stallDeliveries) return; // never respond -> fetch hangs
		if (path.startsWith('/fail500')) {
			response.statusCode = 500;
			response.end('nope');
			return;
		}
		if (path.startsWith('/gone410')) {
			response.statusCode = 410;
			response.end();
			return;
		}
		if (path.startsWith('/redirect302')) {
			// 3xx must be a FAILURE for the sender (redirect: 'manual') and the
			// target must never be fetched.
			response.statusCode = 302;
			response.setHeader('location', `${httpBase}/redirect-target`);
			response.end();
			return;
		}
		response.statusCode = 200;
		response.end('ok');
	});
});
await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const httpPort = (httpServer.address() as { port: number }).port;
const httpBase = `http://127.0.0.1:${httpPort}`;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function latestDailyDueUtc(hour: number, minute: number, now: Date): Date {
	const candidate = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0)
	);
	if (candidate.getTime() > now.getTime()) candidate.setUTCDate(candidate.getUTCDate() - 1);
	return candidate;
}

const DAY = 24 * 60 * 60 * 1000;

async function createSchedule(
	job: string,
	cronExpr: string,
	lastDueAt: Date | null
): Promise<string> {
	const [row] = await db
		.insert(jobSchedules)
		.values({ job, cronExpr, tz: 'UTC', isEnabled: true, lastDueAt })
		.returning({ id: jobSchedules.id });
	return row.id;
}

async function scheduleById(id: string) {
	const [row] = await db.select().from(jobSchedules).where(eq(jobSchedules.id, id));
	return row;
}

async function runsFor(job: string) {
	return db.select().from(jobRuns).where(eq(jobRuns.job, job)).orderBy(asc(jobRuns.createdAt));
}

async function createEndpoint(
	name: string,
	path: string,
	secret: string,
	isEnabled = true
): Promise<string> {
	const [row] = await db
		.insert(webhooks)
		.values({ name, payloadUrl: `${httpBase}${path}`, events: ['test.event'], secret, isEnabled })
		.returning({ id: webhooks.id });
	return row.id;
}

async function queueDelivery(webhookId: string, createdAt?: Date): Promise<string> {
	const [row] = await db
		.insert(webhookDeliveries)
		.values({
			webhookId,
			event: 'test.event',
			payload: { hello: 'world' },
			status: 'queued',
			createdAt
		})
		.returning({ id: webhookDeliveries.id });
	return row.id;
}

async function deliveryById(id: string) {
	const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
	return row;
}

function signatureOf(capturedRequest: CapturedRequest, secret: string): boolean {
	const id = capturedRequest.headers['webhook-id'];
	const timestamp = capturedRequest.headers['webhook-timestamp'];
	const signature = capturedRequest.headers['webhook-signature'];
	if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
		return false;
	}
	const expected = signWebhookPayload(secret, id, Number(timestamp), capturedRequest.body);
	return expected === signature;
}

// ---------------------------------------------------------------------------
// Scenarios (plan §7 assertion mapping)
// ---------------------------------------------------------------------------

async function t4CatchUpAndSourceHash(): Promise<void> {
	section('T4 + source_hash: water level 3 days back -> one catch-up run');
	// Captured once per scenario: the expected watermark must not flip if the
	// run happens to straddle its own 01:30Z boundary.
	const due = latestDailyDueUtc(1, 30, new Date());
	const scheduleId = await createSchedule(
		'system.resources',
		'30 1 * * *',
		new Date(due.getTime() - 3 * DAY)
	);
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0, `exit=${result.code}`);

	const runs = await runsFor('system.resources');
	check('exactly one run executed', runs.length === 1, `got ${runs.length}`);
	const run = runs[0];
	check('run succeeded', run?.status === 'succeeded', `status=${run?.status}`);
	check('result.catchup = true', run?.result?.catchup === true, JSON.stringify(run?.result));
	check(
		'result.missed = 2 (three dues in window, one executed)',
		run?.result?.missed === 2,
		JSON.stringify(run?.result)
	);
	check(
		'job summary present (disk reading)',
		typeof (run?.result as Record<string, unknown>)?.disk === 'object'
	);

	const schedule = await scheduleById(scheduleId);
	check(
		'watermark advanced to the most recent due',
		schedule?.lastDueAt?.getTime() === due.getTime(),
		`${schedule?.lastDueAt?.toISOString()} vs ${due.toISOString()}`
	);

	const builtinPath = fileURLToPath(
		new URL(
			`../src/lib/server/jobs/builtin/${builtinModuleFile('system.resources')}`,
			import.meta.url
		)
	);
	const expectedHash = createHash('sha256')
		.update(await readFile(builtinPath))
		.digest('hex');
	check(
		'source_hash equals sha256 of the executing builtin file',
		run?.sourceHash === expectedHash,
		`${run?.sourceHash} vs ${expectedHash}`
	);

	await runDrainOnce();
	check(
		'second tick runs nothing new (watermark at latest due)',
		(await runsFor('system.resources')).length === 1
	);
}

async function t1ConcurrentDoubleDrain(): Promise<void> {
	section('T1: two concurrent drains -> exactly one execution (CAS)');
	await resetLedger();
	const due = latestDailyDueUtc(1, 30, new Date());
	const scheduleId = await createSchedule(
		'system.resources',
		'30 1 * * *',
		new Date(due.getTime() - DAY)
	);
	const first = spawnDrain();
	const second = spawnDrain();
	const [a, b] = await Promise.all([first.done, second.done]);
	check('both drains exit 0', a.code === 0 && b.code === 0, `a=${a.code} b=${b.code}`);

	const runs = await runsFor('system.resources');
	check('exactly one run row', runs.length === 1, `got ${runs.length}`);
	check(
		'the run succeeded (no stale collision)',
		runs.length === 1 && runs[0].status === 'succeeded'
	);
	const schedule = await scheduleById(scheduleId);
	check(
		'watermark advanced exactly once',
		schedule?.lastDueAt?.getTime() === due.getTime(),
		`${schedule?.lastDueAt?.toISOString()}`
	);
	const logs = a.stdout + b.stdout;
	// The loser has three legitimate shapes: lock busy, CAS-lost, or it read
	// the watermark after the winner committed (no due left). What must hold
	// regardless is exactly ONE execution across both drains.
	const succeededLines = (logs.match(/run [0-9a-f-]+: succeeded/g) ?? []).length;
	check(
		'exactly one execution logged across both drains',
		succeededLines === 1,
		`lines=${succeededLines}`
	);
}

async function t2QueuedUnique(): Promise<void> {
	section('T2: double enqueue -> one queued row (23505 idempotent)');
	await resetLedger();
	const first = await enqueueJob(db, 'system.resources', 'cli');
	const second = await enqueueJob(db, 'system.resources', 'cli');
	check('second enqueue deduplicated', second.deduplicated === true);
	check('both calls resolve to the same row', first.id === second.id);
	const queued = await runsFor('system.resources');
	check('exactly one queued row exists', queued.length === 1 && queued[0].status === 'queued');

	// Prove the DB-level invariant itself (not only our catch path).
	let rawCode: string | undefined;
	try {
		await client.unsafe(
			`insert into job_runs (job, trigger, status) values ('system.resources', 'cli', 'queued')`
		);
	} catch (err) {
		rawCode = (err as { code?: string }).code;
	}
	check(
		'raw duplicate insert violates job_runs_job_queued_uniq (23505)',
		rawCode === '23505',
		`code=${rawCode}`
	);

	let unknownThrew = false;
	try {
		await enqueueJob(db, 'ghost.job', 'cli');
	} catch {
		unknownThrew = true;
	}
	check('unknown job rejected', unknownThrew);
}

async function t3StaleReclamation(): Promise<void> {
	section('T3: stale reclamation + order contract (lock first)');
	await resetLedger();
	const fixture = startLockHolder('jobs.prune', true);
	await fixture.ready;
	await killProcess(fixture.child); // <- the crash: lock released, running row dangles
	check('lock released after SIGKILL', await waitUntilLockFree('jobs.prune'));

	const zombie = (await runsFor('jobs.prune')).find((run) => run.status === 'running');
	check('fixture left a dangling running row after SIGKILL', zombie !== undefined);

	await enqueueJob(db, 'jobs.prune', 'cli');
	await runDrainOnce();
	const reclaimed = (await runsFor('jobs.prune')).find((run) => run.id === zombie?.id);
	check(
		'dangling row reclaimed as failed:stale',
		reclaimed?.status === 'failed' && reclaimed?.error === 'stale',
		`status=${reclaimed?.status} error=${reclaimed?.error}`
	);
	check(
		'queued run survived the crash and executed',
		(await runsFor('jobs.prune')).some((run) => run.id !== zombie?.id && run.status === 'succeeded')
	);

	// Negative direction: while the lock is held the reclaimer must NOT touch
	// the running row (lock -> reclaim order contract).
	await resetLedger();
	const fixture2 = startLockHolder('jobs.prune', true);
	await fixture2.ready;
	const heldZombie = (await runsFor('jobs.prune')).find((run) => run.status === 'running');
	await enqueueJob(db, 'jobs.prune', 'cli');
	await runDrainOnce();
	check(
		'lock holder alive -> running row untouched',
		(await runsFor('jobs.prune')).find((run) => run.id === heldZombie?.id)?.status === 'running'
	);
	check(
		'lock holder alive -> queued run untouched',
		(await runsFor('jobs.prune')).some((run) => run.status === 'queued')
	);
	await killProcess(fixture2.child);
	check('lock released after second SIGKILL', await waitUntilLockFree('jobs.prune'));
	await runDrainOnce();
	check(
		'after the holder dies the next tick reclaims and executes',
		(await runsFor('jobs.prune')).every(
			(run) => run.status === 'succeeded' || run.error === 'stale'
		)
	);
}

async function t5ScheduleLockBusy(): Promise<void> {
	section('T5 + schedule-path order contract: lock held -> no watermark move, no reclaim');
	await resetLedger();
	const due = latestDailyDueUtc(1, 30, new Date());
	const water = new Date(due.getTime() - DAY);
	const scheduleId = await createSchedule('system.resources', '30 1 * * *', water);
	// The holder also owns a dangling running row: while the lock is held the
	// reclaim must NOT touch it (lock -> reclaim order on the schedule path).
	const fixture = startLockHolder('system.resources', true);
	await fixture.ready;
	const zombie = (await runsFor('system.resources')).find((run) => run.status === 'running');
	const result = await runDrainOnce();
	check('drain exits 0 while busy', result.code === 0);
	check('no NEW run row written', (await runsFor('system.resources')).length === 1);
	check(
		'lock holder alive -> dangling row untouched (order contract)',
		(await runsFor('system.resources')).find((run) => run.id === zombie?.id)?.status === 'running'
	);
	check(
		'watermark NOT advanced',
		(await scheduleById(scheduleId))?.lastDueAt?.getTime() === water.getTime()
	);
	check('log reports the busy skip', /busy \(lock held\)/.test(result.stdout));

	await killProcess(fixture.child);
	check('lock released', await waitUntilLockFree('system.resources'));
	await runDrainOnce();
	const runs = await runsFor('system.resources');
	const fresh = runs.filter((run) => run.id !== zombie?.id);
	check(
		'next tick reclaims the dangling row and catches up with exactly one run',
		runs.find((run) => run.id === zombie?.id)?.error === 'stale' &&
			fresh.length === 1 &&
			fresh[0].status === 'succeeded',
		`runs=${runs.length}`
	);
	check(
		'watermark advanced on catch-up',
		(await scheduleById(scheduleId))?.lastDueAt?.getTime() === due.getTime()
	);
}

async function t9CrashRecovery(): Promise<void> {
	section('T9: kill a lock-holding process -> reclaim + queued rows survive');
	await resetLedger();
	const fixture = startLockHolder('jobs.prune', true);
	await fixture.ready;
	await killProcess(fixture.child);
	check('lock released after SIGKILL', await waitUntilLockFree('jobs.prune'));
	const zombie = (await runsFor('jobs.prune')).find((run) => run.status === 'running');
	check('dangling running row survives the kill', zombie !== undefined);

	await enqueueJob(db, 'jobs.prune', 'cli');
	await enqueueJob(db, 'system.resources', 'cli');
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0);
	const runs = await runsFor('jobs.prune');
	check(
		'dangling row reclaimed as failed:stale',
		runs.find((run) => run.id === zombie?.id)?.error === 'stale'
	);
	check(
		'queued jobs.prune executed',
		runs.some((run) => run.id !== zombie?.id && run.status === 'succeeded')
	);
	check(
		'queued system.resources executed too',
		(await runsFor('system.resources')).some((run) => run.status === 'succeeded')
	);
}

async function t9bKillRealDrainMidDelivery(): Promise<void> {
	section('T9b: kill a real drain mid-delivery -> the delivery row stays queued');
	await resetLedger();
	captured.length = 0;
	stallDeliveries = true;
	const endpointId = await createEndpoint('stall', '/stall', 'whsec_c2hhcmVkLXNlY3JldA==');
	const deliveryId = await queueDelivery(endpointId);

	const drain = spawnDrain();
	// Wait until the fixture server has received the stalled delivery request.
	for (
		let attempt = 0;
		attempt < 100 && !captured.some((r) => r.path.startsWith('/stall'));
		attempt++
	) {
		await delay(100);
	}
	check(
		'drain reached the delivery attempt (request received)',
		captured.some((r) => r.path.startsWith('/stall'))
	);
	await killProcess(drain.child);
	await drain.done;

	const afterKill = await deliveryById(deliveryId);
	check(
		'killed mid-flight: row still queued (transaction rolled back)',
		afterKill?.status === 'queued',
		`status=${afterKill?.status}`
	);
	check('killed mid-flight: no response code recorded', afterKill?.responseCode === null);

	stallDeliveries = false;
	// The killed connection may take a moment to release its row lock; retry.
	for (let attempt = 0; attempt < 5; attempt++) {
		const result = await runDrainOnce();
		if (result.code !== 0) break;
		if ((await deliveryById(deliveryId))?.status === 'succeeded') break;
		await delay(300);
	}
	const afterRetry = await deliveryById(deliveryId);
	check(
		'delivery succeeded with 200',
		afterRetry?.status === 'succeeded' && afterRetry?.responseCode === 200,
		`status=${afterRetry?.status} code=${afterRetry?.responseCode}`
	);
	const delivered = captured.filter((r) => r.path.startsWith('/stall'));
	check(
		'two attempts captured (killed + retried)',
		delivered.length === 2,
		`got ${delivered.length}`
	);
	// The signature check implies the full Standard Webhooks header shape and
	// the v1 prefix (signatureOf requires all three headers to verify).
	check(
		'signature verified on the retried request',
		signatureOf(delivered[delivered.length - 1], 'whsec_c2hhcmVkLXNlY3JldA==')
	);
}

async function webhookOutcomes(): Promise<void> {
	section('webhooks: failure recording, 410 disables, disabled endpoints skip');
	await resetLedger();
	const failId = await createEndpoint('fail500', '/fail500', 'whsec_c2hhcmVkLXNlY3JldA==');
	const goneId = await createEndpoint('gone410', '/gone410', 'whsec_c2hhcmVkLXNlY3JldA==');
	const disabledId = await createEndpoint(
		'disabled',
		'/disabled-target',
		'whsec_c2hhcmVkLXNlY3JldA==',
		false
	);
	const failDelivery = await queueDelivery(failId);
	const goneDelivery = await queueDelivery(goneId);
	const disabledDelivery = await queueDelivery(disabledId);

	await runDrainOnce();

	const fail = await deliveryById(failDelivery);
	check(
		'500 -> failed with response_code 500',
		fail?.status === 'failed' && fail?.responseCode === 500,
		`status=${fail?.status} code=${fail?.responseCode}`
	);
	const gone = await deliveryById(goneDelivery);
	check(
		'410 -> failed with response_code 410',
		gone?.status === 'failed' && gone?.responseCode === 410
	);
	const [endpoint] = await db.select().from(webhooks).where(eq(webhooks.id, goneId));
	check('410 disables the endpoint (Standard Webhooks etiquette)', endpoint?.isEnabled === false);
	const disabled = await deliveryById(disabledDelivery);
	check(
		'disabled endpoint -> failed without a request',
		disabled?.status === 'failed' &&
			disabled?.responseCode === null &&
			!captured.some((r) => r.path.startsWith('/disabled-target')),
		`status=${disabled?.status}`
	);

	const before = captured.filter((r) => r.path.startsWith('/fail500')).length;
	const again = await runDrainOnce();
	check('second tick exits 0', again.code === 0);
	check(
		'v1: no retry - failed rows stay failed, no new request',
		(await deliveryById(failDelivery))?.status === 'failed' &&
			captured.filter((r) => r.path.startsWith('/fail500')).length === before
	);
}

async function jobsPruneRetention(): Promise<void> {
	section('jobs.prune: retention windows (runs/activities 24 months, deliveries 30 days)');
	await resetLedger();
	const months = (count: number) => new Date(Date.now() - count * 30.5 * DAY);
	const okEndpoint = await createEndpoint('ok', '/ok', 'whsec_c2hhcmVkLXNlY3JldA==');

	const [oldTerminalRun] = await db
		.insert(jobRuns)
		.values({
			job: 'system.resources',
			trigger: 'cli',
			status: 'succeeded',
			createdAt: months(25),
			startedAt: months(25),
			finishedAt: months(25)
		})
		.returning({ id: jobRuns.id });
	const [oldFailedRun] = await db
		.insert(jobRuns)
		.values({
			job: 'jobs.prune',
			trigger: 'cli',
			status: 'failed',
			createdAt: months(25),
			error: 'x'
		})
		.returning({ id: jobRuns.id });
	const [recentRun] = await db
		.insert(jobRuns)
		.values({
			job: 'system.resources',
			trigger: 'cli',
			status: 'succeeded',
			startedAt: new Date(),
			finishedAt: new Date()
		})
		.returning({ id: jobRuns.id });

	const [oldDelivered] = await db
		.insert(webhookDeliveries)
		.values({
			webhookId: okEndpoint,
			event: 'test.event',
			payload: {},
			status: 'succeeded',
			responseCode: 200,
			createdAt: months(1)
		})
		.returning({ id: webhookDeliveries.id });
	const oldQueuedDelivery = await queueDelivery(okEndpoint, months(1));

	const [oldActivity] = await db
		.insert(activities)
		.values({ event: 'job.prune', createdAt: months(25) })
		.returning({ id: activities.id });
	const [recentActivity] = await db
		.insert(activities)
		.values({ event: 'job.prune', createdAt: new Date() })
		.returning({ id: activities.id });

	await enqueueJob(db, 'jobs.prune', 'cli');
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0);

	const pruneRun = (await runsFor('jobs.prune')).find((run) => run.status === 'succeeded');
	const pruneResult = pruneRun?.result as Record<string, number> | null | undefined;
	check(
		'prune result reports two job_runs deletions',
		pruneResult?.jobRuns === 2,
		JSON.stringify(pruneResult)
	);
	check(
		'prune result reports one delivery deletion',
		pruneResult?.webhookDeliveries === 1,
		JSON.stringify(pruneResult)
	);
	check(
		'prune result reports one activity deletion',
		pruneResult?.activities === 1,
		JSON.stringify(pruneResult)
	);

	const runIds = (await runsFor('system.resources')).map((run) => run.id);
	check('25-month-old terminal run deleted', !runIds.includes(oldTerminalRun.id));
	check(
		'25-month-old failed run deleted',
		!(await runsFor('jobs.prune')).some((run) => run.id === oldFailedRun.id)
	);
	check('recent run kept', runIds.includes(recentRun.id));
	check('30-day-old delivered row deleted', !(await deliveryById(oldDelivered.id)));
	const keptDelivery = await deliveryById(oldQueuedDelivery);
	check(
		'old queued delivery NOT pruned (queued is not garbage) and got delivered',
		keptDelivery !== undefined && keptDelivery.status === 'succeeded'
	);
	check(
		'old activity deleted',
		!(await db.select().from(activities).where(eq(activities.id, oldActivity.id))).length
	);
	check(
		'recent activity kept',
		(await db.select().from(activities).where(eq(activities.id, recentActivity.id))).length === 1
	);
}

async function unknownScheduleJob(): Promise<void> {
	section('unknown schedule job: skipped loudly, watermark untouched, tick survives');
	await resetLedger();
	const water = new Date(latestDailyDueUtc(1, 30, new Date()).getTime() - DAY);
	const scheduleId = await createSchedule('ghost.job', '30 1 * * *', water);
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0);
	check('no runs created', (await runsFor('ghost.job')).length === 0);
	check(
		'watermark untouched',
		(await scheduleById(scheduleId))?.lastDueAt?.getTime() === water.getTime()
	);
	check('logged as unknown job', /unknown job "ghost\.job"/.test(result.stdout));
}

async function bootstrapWaterLevel(): Promise<void> {
	section('bootstrap: NULL watermark -> initialized to now, never fires for the past');
	await resetLedger();
	const scheduleId = await createSchedule('system.resources', '30 1 * * *', null);
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0);
	check('logged the bootstrap', /water level initialized/.test(result.stdout));
	const schedule = await scheduleById(scheduleId);
	check('watermark initialized', schedule?.lastDueAt != null);
	check(
		'watermark set to ~now (no backfill)',
		schedule?.lastDueAt != null && Math.abs(schedule.lastDueAt.getTime() - Date.now()) < 60_000
	);
	check('no run fired', (await runsFor('system.resources')).length === 0);
}

async function schedulePathReclaim(): Promise<void> {
	section('T3 (schedule path): a due point reclaims danglings before firing');
	await resetLedger();
	const [zombie] = await db
		.insert(jobRuns)
		.values({
			job: 'system.resources',
			trigger: 'cli',
			status: 'running',
			startedAt: new Date(Date.now() - 3_600_000),
			sourceHash: 'fixture'
		})
		.returning({ id: jobRuns.id });
	await createSchedule(
		'system.resources',
		'30 1 * * *',
		new Date(latestDailyDueUtc(1, 30, new Date()).getTime() - DAY)
	);
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0);
	const runs = await runsFor('system.resources');
	const reclaimed = runs.find((run) => run.id === zombie.id);
	check(
		'dangling row reclaimed as failed:stale',
		reclaimed?.status === 'failed' && reclaimed?.error === 'stale'
	);
	check(
		'finished_at left NULL on the reclaimed row (no fake duration)',
		reclaimed?.finishedAt === null
	);
	const fresh = runs.filter((run) => run.id !== zombie.id);
	check(
		'the due point still fired exactly once',
		fresh.length === 1 && fresh[0].status === 'succeeded',
		`fresh=${fresh.length}`
	);
}

async function poisonJobRecordsFailure(): Promise<void> {
	section('executeRun failure branch: a throwing job lands failed + error, tick survives');
	await resetLedger();
	// Break a table jobs.prune touches so the job throws mid-run.
	await client.unsafe('alter table activities rename to activities_poisoned');
	try {
		await enqueueJob(db, 'jobs.prune', 'cli');
		const result = await runDrainOnce();
		check('drain exits 0 despite the job failure', result.code === 0);
		const failed = (await runsFor('jobs.prune')).find((run) => run.status === 'failed');
		check('run recorded as failed', failed !== undefined);
		check(
			'error text captured',
			typeof failed?.error === 'string' && failed.error.length > 0,
			failed?.error ?? ''
		);
		check('finished_at set on the failure', failed?.finishedAt != null);
	} finally {
		await client.unsafe('alter table activities_poisoned rename to activities');
	}
}

async function preciseWatermarkFromSql(): Promise<void> {
	section('watermark written by SQL now() (microseconds) still fires (monotonic CAS)');
	await resetLedger();
	// now() carries microseconds; the drizzle/postgres.js round-trip is
	// milliseconds. An equality CAS would never match this watermark and the
	// schedule would silently never fire - the monotonic CAS must advance it.
	const rows = await client.unsafe(
		`insert into job_schedules (job, cron_expr, tz, is_enabled, last_due_at)
		 values ('system.resources', '* * * * *', 'UTC', true, now() - interval '90 seconds')
		 returning id, last_due_at`
	);
	const scheduleId = rows[0].id as string;
	// `unsafe` runs on the simple protocol - timestamptz comes back as text.
	const stored = new Date(rows[0].last_due_at as string | Date);
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0);
	const runs = await runsFor('system.resources');
	check(
		'the minutely schedule fired despite the µs watermark',
		runs.length === 1,
		`runs=${runs.length}`
	);
	const schedule = await scheduleById(scheduleId);
	check(
		'watermark advanced past the stored value',
		schedule?.lastDueAt != null && schedule.lastDueAt.getTime() > stored.getTime()
	);
	await db.delete(jobSchedules).where(eq(jobSchedules.id, scheduleId));
}

async function concurrentDeliveryClaim(): Promise<void> {
	section('deliveries: two concurrent drains -> the delivery is sent exactly once');
	await resetLedger();
	captured.length = 0;
	stallDeliveries = false;
	const endpointId = await createEndpoint('ok', '/ok', 'whsec_c2hhcmVkLXNlY3JldA==');
	const deliveryId = await queueDelivery(endpointId);
	const first = spawnDrain();
	const second = spawnDrain();
	const [a, b] = await Promise.all([first.done, second.done]);
	check('both drains exit 0', a.code === 0 && b.code === 0, `a=${a.code} b=${b.code}`);
	const delivery = await deliveryById(deliveryId);
	check('delivery succeeded', delivery?.status === 'succeeded', `status=${delivery?.status}`);
	const posts = captured.filter((r) => r.path.startsWith('/ok') && r.method === 'POST');
	check('exactly one POST reached the receiver', posts.length === 1, `posts=${posts.length}`);
}

async function redirectIsAFailure(): Promise<void> {
	section('delivery: 3xx is a failure and the redirect target is never fetched');
	await resetLedger();
	captured.length = 0;
	const endpointId = await createEndpoint('redirect', '/redirect302', 'whsec_c2hhcmVkLXNlY3JldA==');
	const deliveryId = await queueDelivery(endpointId);
	await runDrainOnce();
	const delivery = await deliveryById(deliveryId);
	check(
		'302 -> failed with response_code 302',
		delivery?.status === 'failed' && delivery?.responseCode === 302,
		`status=${delivery?.status} code=${delivery?.responseCode}`
	);
	check(
		'redirect target never fetched (redirect: manual)',
		!captured.some((r) => r.path.startsWith('/redirect-target'))
	);
	check(
		'redirect endpoint hit exactly once',
		captured.filter((r) => r.path.startsWith('/redirect302')).length === 1
	);
}

/** Reserve a port on the loopback and close it again - connections are refused. */
async function reserveClosedPort(): Promise<number> {
	return new Promise<number>((resolve) => {
		const probe = createNetServer();
		probe.listen(0, '127.0.0.1', () => {
			const port = (probe.address() as { port: number }).port;
			probe.close(() => resolve(port));
		});
	});
}

async function deadEndpointRecordsNetworkFailure(): Promise<void> {
	section('delivery: unreachable endpoint -> failed, no response code, sanitized error');
	await resetLedger();
	const deadPort = await reserveClosedPort();
	const [endpoint] = await db
		.insert(webhooks)
		.values({
			name: 'dead',
			payloadUrl: `http://127.0.0.1:${deadPort}/hook`,
			events: ['test.event'],
			secret: 'whsec_c2hhcmVkLXNlY3JldA==',
			isEnabled: true
		})
		.returning({ id: webhooks.id });
	const deliveryId = await queueDelivery(endpoint.id);
	const result = await runDrainOnce();
	check('drain exits 0', result.code === 0);
	const delivery = await deliveryById(deliveryId);
	check(
		'unreachable endpoint -> failed, response_code NULL',
		delivery?.status === 'failed' && delivery?.responseCode === null,
		`status=${delivery?.status}`
	);
	check(
		'network error recorded and sanitized (no params tail, capped at 500)',
		typeof delivery?.error === 'string' &&
			delivery.error.length > 0 &&
			delivery.error.length <= 500 &&
			!delivery.error.includes('params:')
	);
}

async function exitCodesContract(): Promise<void> {
	section('entry contract: exit 2 without DATABASE_URL, exit 1 against an unreachable server');
	const noEnv = { ...process.env };
	delete noEnv.DATABASE_URL;
	delete noEnv.JOBS_HEARTBEAT_URL;
	noEnv.DATA_DIR = join(fixtureDataDir, 'nocfg');
	const missing = spawn(process.execPath, ['jobs/drain.ts'], { cwd: repoRoot, env: noEnv });
	spawnedChildren.add(missing);
	const missingResult = await new Promise<DrainResult>((resolve) => {
		let stderr = '';
		missing.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		missing.on('close', (code) => {
			spawnedChildren.delete(missing);
			resolve({ code, stdout: '', stderr });
		});
	});
	check('missing DATABASE_URL -> exit 2', missingResult.code === 2, `exit=${missingResult.code}`);
	check('config error is explained', /DATABASE_URL is not set/.test(missingResult.stderr));

	const deadPort = await reserveClosedPort();
	const unreachable = spawnDrain({
		DATABASE_URL: `postgres://root:root@127.0.0.1:${deadPort}/${scratchName}`
	});
	const unreachableResult = await unreachable.done;
	check(
		'unreachable database -> exit 1',
		unreachableResult.code === 1,
		`exit=${unreachableResult.code}`
	);
	check('tick failure is explained', /tick failed/.test(unreachableResult.stderr));
}

async function queueContentionSingleExecution(): Promise<void> {
	section('queue: two concurrent drains -> the queued row executes exactly once');
	await resetLedger();
	await enqueueJob(db, 'system.resources', 'cli');
	const first = spawnDrain();
	const second = spawnDrain();
	const [a, b] = await Promise.all([first.done, second.done]);
	check('both drains exit 0', a.code === 0 && b.code === 0, `a=${a.code} b=${b.code}`);
	const runs = await runsFor('system.resources');
	check(
		'exactly one run row, succeeded',
		runs.length === 1 && runs[0].status === 'succeeded',
		`runs=${runs.length}`
	);
	const logs = a.stdout + b.stdout;
	check(
		'exactly one execution logged across both drains',
		(logs.match(/run [0-9a-f-]+: succeeded/g) ?? []).length === 1
	);
}

async function heartbeatPing(): Promise<void> {
	section('heartbeat: JOBS_HEARTBEAT_URL receives a ping after the tick');
	await resetLedger();
	captured.length = 0;
	const result = await runDrainOnce({ JOBS_HEARTBEAT_URL: `${httpBase}/beat` });
	check('drain exits 0', result.code === 0);
	check(
		'ping received',
		captured.some((r) => r.path === '/beat' && r.method === 'GET')
	);
}

// ---------------------------------------------------------------------------
// J-2 scenarios: SDK resolution, save gate, user jobs end-to-end (T6/T7/T10)
// ---------------------------------------------------------------------------

function sha256Of(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Spawn a plain Node probe (same pattern as startLockHolder). */
async function runNodeScript(script: string): Promise<DrainResult> {
	const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
		cwd: repoRoot,
		env: { ...process.env, DATA_DIR: fixtureDataDir }
	});
	spawnedChildren.add(child);
	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
	return new Promise<DrainResult>((resolve) => {
		child.on('close', (code) => {
			spawnedChildren.delete(child);
			resolve({ code, stdout, stderr });
		});
	});
}

async function writeUserJob(dataDir: string, file: string, content: string): Promise<void> {
	const dir = join(dataDir, 'jobs');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, file), content, 'utf8');
}

async function t6SdkDualResolution(): Promise<void> {
	section('T6: #jobs-sdk resolves under plain Node AND tsc (temp DATA_DIR)');
	const dataDir = join(fixtureDataDir, 't6');
	await ensureJobsScaffold(dataDir);
	await writeUserJob(
		dataDir,
		'probe-sdk.ts',
		"import { getDb, sql, type JobContext } from '#jobs-sdk';\nexport default { run(ctx: JobContext) { return [typeof getDb, typeof sql, typeof ctx.job] as const; } };\n"
	);

	const nodeProbe = await runNodeScript(`
		const { pathToFileURL } = await import('node:url');
		const mod = await import(pathToFileURL(${JSON.stringify(join(dataDir, 'jobs', 'probe-sdk.ts'))}).href);
		if (typeof mod.default?.run !== 'function') throw new Error('probe did not load');
		console.log('NODE-RESOLVED');
	`);
	check(
		'T6 node: the scaffold runtime resolves #jobs-sdk for a user file',
		nodeProbe.code === 0 && nodeProbe.stdout.includes('NODE-RESOLVED'),
		nodeProbe.stderr.slice(0, 300)
	);

	const typecheck = await runJobsTypecheck({ dataDir });
	check(
		'T6 tsc: the generated tsconfig resolves the facade with zero diagnostics',
		typecheck.ok && typecheck.fileCount === 1,
		JSON.stringify(typecheck.issues.slice(0, 3)) + (typecheck.runnerError ?? '')
	);
}

async function t7SaveGateNegatives(): Promise<void> {
	section('T7: the save gate rejects enum / unlisted imports with positions');
	const enumReport = await runSaveGate({
		name: 'bad-enum',
		code: 'const a = 1;\n\nenum E { A }\n'
	});
	const enumError = enumReport.errors.find((error) => error.code === 1294);
	check(
		'T7 enum rejected with TS 1294 + a line position',
		!enumReport.ok && enumError?.line === 3 && typeof enumError?.column === 'number',
		JSON.stringify(enumReport.errors.slice(0, 2))
	);
	const importReport = await runSaveGate({
		name: 'bad-imports',
		code: "import fs from 'node:fs';\nimport zod from 'zod';\nimport helper from './helper';\nexport default {};\n"
	});
	const lintLines = importReport.errors
		.filter((error) => error.source === 'eslint')
		.map((error) => error.line);
	check(
		'T7 unlisted imports rejected with positions (zod / relative)',
		JSON.stringify(lintLines) === '[2,3]',
		JSON.stringify(importReport.errors)
	);
	const okReport = await runSaveGate({
		name: 'ok-task',
		code: "import { readFile } from 'node:fs/promises';\nimport { type JobContext } from '#jobs-sdk';\nexport default { run(ctx: JobContext) { ctx.logger.info(String(readFile)); } };\n"
	});
	check('T7 positive control passes', okReport.ok);
}

async function t10UserJobEndToEnd(): Promise<void> {
	section('T10: user jobs run, hot-update next tick, override builtins, use the bound SDK');
	await resetLedger();
	const dataDir = join(fixtureDataDir, 't10');
	const heatLog = join(dataDir, 'heat.log');
	const jobSource = (version: string) => `import { appendFile } from 'node:fs/promises';
export default {
	async run(ctx) {
		await appendFile(${JSON.stringify(heatLog)}, '${version}\\n');
		ctx.summary({ version: '${version}' });
	}
};
`;
	await writeUserJob(dataDir, 'heat-task.ts', jobSource('v1'));

	const definition = await resolveJobDefinition('heat-task', dataDir);
	check(
		'T10 user-only job resolves with the R1-2 defaults',
		definition !== null && definition.manual && definition.timeoutMs === 300_000
	);

	await enqueueJob(db, 'heat-task', 'cli', definition!);
	const first = await runDrainOnce({ DATA_DIR: dataDir });
	check('T10 first drain exits 0', first.code === 0, first.stdout + first.stderr);
	const v1Hash = sha256Of(await readFile(join(dataDir, 'jobs', 'heat-task.ts')));
	const runsAfterFirst = await runsFor('heat-task');
	check(
		'T10 v1 ran once, succeeded, source_hash = the file hash',
		runsAfterFirst.length === 1 &&
			runsAfterFirst[0].status === 'succeeded' &&
			runsAfterFirst[0].sourceHash === v1Hash,
		JSON.stringify(runsAfterFirst[0]?.status)
	);
	check(
		'T10 v1 marker written by the job itself',
		(await readFile(heatLog, 'utf8')).includes('v1')
	);

	// Hot update (plan §2 "each tick is a fresh process"): the next tick must
	// execute the NEW bytes - source_hash is the proof.
	await writeUserJob(dataDir, 'heat-task.ts', jobSource('v2'));
	await enqueueJob(db, 'heat-task', 'cli', definition!);
	const second = await runDrainOnce({ DATA_DIR: dataDir });
	check('T10 second drain exits 0', second.code === 0);
	const v2Hash = sha256Of(await readFile(join(dataDir, 'jobs', 'heat-task.ts')));
	const runsAfterSecond = await runsFor('heat-task');
	check(
		'T10 v2 executed with a NEW source_hash (no stale code)',
		runsAfterSecond.length === 2 && runsAfterSecond[1].sourceHash === v2Hash && v2Hash !== v1Hash,
		`count=${runsAfterSecond.length}`
	);
	check('T10 v2 marker appended', (await readFile(heatLog, 'utf8')).includes('v2'));

	// Run-scoped SDK binding (R2-3): a bare getOption() has no executor and
	// must resolve through the client the drain bound for this run.
	await writeUserJob(
		dataDir,
		'sdk-bind.ts',
		"import { getOption } from '#jobs-sdk';\nexport default {\n\tasync run(ctx) {\n\t\tconst checks = await getOption('friends.checks');\n\t\tctx.summary({ boundChecksType: typeof checks });\n\t}\n};\n"
	);
	const bindDefinition = await resolveJobDefinition('sdk-bind', dataDir);
	await enqueueJob(db, 'sdk-bind', 'cli', bindDefinition!);
	const third = await runDrainOnce({ DATA_DIR: dataDir });
	const bindRun = (await runsFor('sdk-bind'))[0];
	check(
		'T10 bare getOption resolves via the run-scoped binding',
		third.code === 0 && bindRun?.status === 'succeeded',
		bindRun?.error ?? ''
	);

	// User > builtin at runtime: a forked builtin name executes the user file.
	await writeUserJob(
		dataDir,
		'system-resources.ts',
		`import { appendFile } from 'node:fs/promises';
export default {
	async run() {
		await appendFile(${JSON.stringify(heatLog)}, 'fork\\n');
	}
};
`
	);
	const forkDefinition = await resolveJobDefinition('system.resources', dataDir);
	await enqueueJob(db, 'system.resources', 'cli', forkDefinition!);
	const fourth = await runDrainOnce({ DATA_DIR: dataDir });
	const forkRun = (await runsFor('system.resources'))[0];
	check(
		'T10 user fork overrides the builtin at runtime',
		fourth.code === 0 &&
			forkRun?.status === 'succeeded' &&
			(await readFile(heatLog, 'utf8')).includes('fork'),
		forkRun?.error ?? ''
	);
	const forkHash = sha256Of(await readFile(join(dataDir, 'jobs', 'system-resources.ts')));
	check(
		'T10 fork run records the USER file hash (user>builtin at the hash level)',
		forkRun?.sourceHash === forkHash,
		`run=${String(forkRun?.sourceHash).slice(0, 8)} file=${forkHash.slice(0, 8)}`
	);
}

async function t12MidTickConfigChange(): Promise<void> {
	section('T12: admin edit mid-tick -> the CAS loses on the config snapshot (J-3 review F1)');
	await resetLedger();
	const dataDir = join(fixtureDataDir, 't12');
	await ensureJobsScaffold(dataDir);
	// Row 1 (created first -> processed first, createdAt asc) is a SLOW user
	// job: it signals via a marker file, then sleeps 70s. The marker starts
	// the race clock; the >60s sleep guarantees the minutely grid puts the
	// stale snapshot's latestDue ABOVE the admin's reset watermark, so under
	// the old monotonic-only predicate the tick WOULD match and fire - the
	// scenario is a true kill for the config-snapshot predicate.
	const startedLog = join(dataDir, 'slow-started.log');
	await writeUserJob(
		dataDir,
		'slow-task.ts',
		`import { appendFile } from 'node:fs/promises';
export default {
	async run() {
		await appendFile(${JSON.stringify(startedLog)}, 'started');
		await new Promise((resolve) => setTimeout(resolve, 70_000));
	}
};
`
	);
	const dueA = latestDailyDueUtc(1, 30, new Date());
	await createSchedule('slow-task', '30 1 * * *', new Date(dueA.getTime() - DAY));
	await delay(25); // distinct created_at so the slow row sorts first
	const targetId = await createSchedule(
		'system.resources',
		'* * * * *',
		new Date(Date.now() - 90_000)
	);

	const drain = spawnDrain({ DATA_DIR: dataDir });
	let started = false;
	for (let i = 0; i < 300 && !started; i++) {
		try {
			started = (await readFile(startedLog, 'utf8')).includes('started');
		} catch {
			started = false;
		}
		if (!started) await delay(50);
	}
	check('T12 slow row signalled mid-tick', started);
	// Mid-tick edit on row 2 (still unprocessed): new expression + watermark
	// reset, exactly what scheduleUpdate writes.
	const resetAt = new Date();
	await db
		.update(jobSchedules)
		.set({ cronExpr: '0 4 * * *', lastDueAt: resetAt })
		.where(eq(jobSchedules.id, targetId));
	const result = await drain.done;
	check('T12 drain exits 0', result.code === 0, result.stdout + result.stderr);
	check('T12 slow row ran under the first expression', (await runsFor('slow-task')).length === 1);
	check(
		'T12 log names the mid-tick config loss',
		/config changed mid-tick/.test(result.stdout),
		result.stdout
	);
	const target = await scheduleById(targetId);
	check(
		'T12 admin watermark reset survives (no clobber, no run under the old expression)',
		target?.lastDueAt?.getTime() === resetAt.getTime() &&
			(await runsFor('system.resources')).length === 0,
		`water=${target?.lastDueAt?.toISOString()} runs=${(await runsFor('system.resources')).length}`
	);
}

async function t12bToggleCasRealDb(): Promise<void> {
	section('T12b: toggle CAS loses a racing flip on a real database (J-3 review M13)');
	await resetLedger();
	const id = await createSchedule('jobs.prune', '* * * * *', new Date());
	await db.update(jobSchedules).set({ isEnabled: false }).where(eq(jobSchedules.id, id));
	// The racing writer flips the row inside the service's read->write
	// window: the conditional write (`is_enabled = <read value>`) must then
	// lose, and the service answers `stale` instead of overwriting the racer.
	const flippingDb = {
		select: db.select.bind(db),
		transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
			await db.update(jobSchedules).set({ isEnabled: true }).where(eq(jobSchedules.id, id));
			return db.transaction(cb as never);
		}
	};
	const result = await toggleSchedule({
		db: flippingDb as never,
		id,
		enabled: true,
		actorId: null
	});
	check('T12b racing flip answers stale', result.kind === 'stale', JSON.stringify(result));
	check('T12b the racer state is not overwritten', (await scheduleById(id))?.isEnabled === true);
	check('T12b no audit row for the lost toggle', (await db.select().from(activities)).length === 0);
}

async function t11DeleteLifecycle(): Promise<void> {
	section('T11: deleteUserJob cleans schedules/queued/running in one tx, keeps history (real DB)');
	await resetLedger();
	const dataDir = join(fixtureDataDir, 't11');
	await ensureJobsScaffold(dataDir);
	await writeUserJob(dataDir, 'doomed.ts', 'export default { run() {} };\n');
	await writeUserJob(dataDir, 'keeper.ts', 'export default { run() {} };\n');
	await createSchedule('doomed', '* * * * *', new Date());
	await createSchedule('doomed', '0 4 * * *', new Date());
	await createSchedule('keeper', '* * * * *', new Date());
	await db.insert(jobRuns).values({ job: 'doomed', trigger: 'cli', status: 'queued' });
	await db.insert(jobRuns).values({
		job: 'doomed',
		trigger: 'cli',
		status: 'running',
		startedAt: new Date(),
		sourceHash: 'fixture'
	});
	await db.insert(jobRuns).values({
		job: 'doomed',
		trigger: 'cli',
		status: 'succeeded',
		startedAt: new Date(),
		finishedAt: new Date()
	});
	await db.insert(jobRuns).values({ job: 'keeper', trigger: 'cli', status: 'queued' });

	const result = await deleteUserJob({ dataDir, name: 'doomed', actorId: null, db: db as never });
	check(
		'T11 delete reports 2 schedules / 1 queued / 1 running finalized',
		result.kind === 'deleted' &&
			result.schedulesRemoved === 2 &&
			result.queuedRemoved === 1 &&
			result.runningFinalized === 1,
		JSON.stringify(result)
	);
	const doomedRuns = await runsFor('doomed');
	check(
		'T11 running row finalized as failed (job deleted)',
		doomedRuns.some((run) => run.status === 'failed' && run.error === 'unknown job (job deleted)')
	);
	check(
		'T11 terminal history kept (jobs.prune owns retention)',
		doomedRuns.some((run) => run.status === 'succeeded')
	);
	check(
		'T11 doomed schedules gone',
		(await db.select().from(jobSchedules).where(eq(jobSchedules.job, 'doomed'))).length === 0
	);
	const keeperSchedules = await db
		.select()
		.from(jobSchedules)
		.where(eq(jobSchedules.job, 'keeper'));
	const keeperRuns = await runsFor('keeper');
	check(
		'T11 keeper rows untouched (where-clause scope)',
		keeperSchedules.length === 1 && keeperRuns.length === 1 && keeperRuns[0].status === 'queued'
	);
	const audit = await db.select().from(activities).where(eq(activities.event, 'job.delete'));
	check(
		'T11 audit row committed with the transaction',
		audit.some((row) => (row.payload as { name?: string } | null)?.name === 'doomed')
	);
	const fileGone = await readFile(join(dataDir, 'jobs', 'doomed.ts'), 'utf8').then(
		() => false,
		() => true
	);
	check('T11 user file removed after the commit', fileGone);

	// Alias names must be refused by delete too (J-2 review round 2, D1):
	// `system-resources` is the module file of the system.resources fork, and
	// `my.task` maps onto another job's `my-task.ts` - both would otherwise
	// remove the WRONG file.
	await writeUserJob(dataDir, 'system-resources.ts', 'export default { run() {} };\n');
	await writeUserJob(dataDir, 'my-task.ts', 'export default { run() {} };\n');
	const aliasFork = await deleteUserJob({
		dataDir,
		name: 'system-resources',
		actorId: null,
		db: db as never
	});
	const aliasDotted = await deleteUserJob({
		dataDir,
		name: 'my.task',
		actorId: null,
		db: db as never
	});
	const survives = (file: string): Promise<boolean> =>
		readFile(join(dataDir, 'jobs', file), 'utf8').then(
			() => true,
			() => false
		);
	check(
		'T11 delete refuses module-file and dotted aliases (files survive)',
		aliasFork.kind === 'not-user-job' &&
			aliasDotted.kind === 'not-user-job' &&
			(await survives('system-resources.ts')) &&
			(await survives('my-task.ts')),
		`${JSON.stringify(aliasFork)} ${JSON.stringify(aliasDotted)}`
	);
}

async function scaffoldFailureDegrades(): Promise<void> {
	section('scaffold failure: the tick survives and builtin work still runs (J-2 review F5)');
	await resetLedger();
	// DATA_DIR points at a FILE, so `mkdir` inside ensureJobsScaffold fails.
	const blocked = join(fixtureDataDir, 'blocked-scaffold');
	await writeFile(blocked, 'not a directory', 'utf8');
	await enqueueJob(db, 'system.resources', 'cli');
	const result = await runDrainOnce({ DATA_DIR: blocked });
	check(
		'drain exits 0 despite the scaffold failure',
		result.code === 0,
		result.stdout + result.stderr
	);
	check('scaffold failure is logged', /scaffold ensure failed/.test(result.stderr + result.stdout));
	const runs = await runsFor('system.resources');
	check(
		'builtin job still executed',
		runs.length === 1 && runs[0].status === 'succeeded',
		JSON.stringify(runs[0]?.status)
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log(`creating scratch database ${scratchName} ...`);
	await admin.unsafe(`create database "${scratchName}"`);

	// Best-effort hygiene: drop leftover scratch databases from runs that were
	// killed before their teardown (only when idle, so a live sibling run is
	// never disturbed).
	try {
		const leftovers = await admin.unsafe(
			`select datname from pg_database where datname like 'wl_jobs_verify_%' and datname <> $1`,
			[scratchName]
		);
		for (const row of leftovers) {
			const name = String(row.datname);
			if (!name.startsWith('wl_jobs_verify_')) continue;
			// Age gate: a sibling run's fresh database has NO connections yet
			// (the client connects lazily), so an idle check alone could drop
			// it mid-setup. Only sweep databases older than 10 minutes (the
			// name embeds the creation timestamp in base36).
			const stamp = Number.parseInt(name.slice('wl_jobs_verify_'.length).split('_')[0] ?? '', 36);
			if (!Number.isFinite(stamp) || Date.now() - stamp < 10 * 60 * 1000) continue;
			const active = await admin.unsafe(
				`select count(*)::int as count from pg_stat_activity where datname = $1`,
				[name]
			);
			if ((active[0]?.count ?? 0) > 0) continue;
			await admin.unsafe(`drop database if exists "${name}"`);
			console.log(`  (swept leftover scratch database ${name})`);
		}
	} catch {
		/* hygiene is best-effort */
	}

	console.log('applying baseline migration ...');
	await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });

	await t4CatchUpAndSourceHash();
	await t1ConcurrentDoubleDrain();
	await t2QueuedUnique();
	await t3StaleReclamation();
	await t5ScheduleLockBusy();
	await t9CrashRecovery();
	await t9bKillRealDrainMidDelivery();
	await webhookOutcomes();
	await jobsPruneRetention();
	await unknownScheduleJob();
	await bootstrapWaterLevel();
	await schedulePathReclaim();
	await poisonJobRecordsFailure();
	await preciseWatermarkFromSql();
	await concurrentDeliveryClaim();
	await redirectIsAFailure();
	await deadEndpointRecordsNetworkFailure();
	await exitCodesContract();
	await queueContentionSingleExecution();
	await heartbeatPing();
	await t6SdkDualResolution();
	await t7SaveGateNegatives();
	await t10UserJobEndToEnd();
	await t11DeleteLifecycle();
	await t12MidTickConfigChange();
	await t12bToggleCasRealDb();
	await scaffoldFailureDegrades();

	console.log(
		`\n${failures === 0 ? 'ALL' : `${failures} of`} ${checks} checks ${failures === 0 ? 'passed' : 'FAILED'}`
	);
}

let scenarioError: unknown = null;
try {
	await main();
} catch (err) {
	scenarioError = err;
	console.error('\nharness error:', err instanceof Error ? err.stack : err);
} finally {
	httpServer.closeAllConnections?.();
	httpServer.close();
	// Kill any fixture/drain children still alive (a mid-scenario failure must
	// not leave lock-holding orphans behind).
	for (const child of spawnedChildren) {
		try {
			child.kill('SIGKILL');
		} catch {
			/* already gone */
		}
	}
	try {
		if (lockProbeRef.current) await lockProbeRef.current.release();
	} catch {
		/* already gone */
	}
	try {
		await client.end({ timeout: 5 });
	} catch {
		/* already gone */
	}
	try {
		await admin.unsafe(
			`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
			[scratchName]
		);
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				await admin.unsafe(`drop database if exists "${scratchName}"`);
				break;
			} catch {
				await delay(500);
			}
		}
		console.log(`dropped scratch database ${scratchName}`);
	} catch {
		/* nothing left to drop */
	}
	try {
		await admin.end({ timeout: 5 });
	} catch {
		/* already gone */
	}
	try {
		await rm(fixtureDataDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}
if (scenarioError) process.exitCode = 1;
else process.exitCode = failures === 0 ? 0 : 1;
