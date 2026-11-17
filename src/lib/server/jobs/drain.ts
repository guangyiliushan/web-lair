import { and, asc, eq, isNull, lt, lte, notInArray } from 'drizzle-orm';
import { jobRuns } from '../db/system/job-run.schema.ts';
import { jobSchedules } from '../db/system/job-schedule.schema.ts';
import { webhooks } from '../db/system/webhook.schema.ts';
import { webhookDeliveries } from '../db/system/webhook-delivery.schema.ts';
import { pgErrorCode } from '../db/pg-error.ts';
import { sanitizeErrorText } from './error-text.ts';
import { bindJobDb } from './sdk-binding.ts';
import { dueWindow } from './due.ts';
import { JOBS } from './registry.ts';
import type { JobDefinition } from './registry.ts';
import { webhookHeaders } from './signature.ts';
import {
	WebhookUrlError,
	assertDeliveryTarget,
	webhookGuardOptionsFromEnv
} from '../webhooks/url-guard.ts';
import { classifyWebhookResponse, parseRetryAfter, planWebhookRetry } from '../webhooks/retry.ts';
import { isSecretError } from '../secrets/errors.ts';
import { reportSecretFailure } from '../secrets/report.ts';
import { recordWebhookAutoDisable } from '../audit.ts';
import { resolveWebhookSigningSecrets } from '../secrets/webhook-secrets.ts';
import { deliverNotification } from '../notifications/delivery.ts';
import type { NotificationDeliveryOutcome } from '../notifications/delivery.ts';
import { notify as defaultNotify } from '../notifications/notify.ts';
import { shouldAlertJobFailure } from '../notifications/events.ts';
import type { SecretDb } from '../secrets/resolver.ts';
import type { JobResult, JobTrigger } from '../db/system/job-run.schema.ts';
import type { JobContext, JobLogger, JobsDb, LoadedJob } from './types.ts';

/**
 * Drain core: one tick = FOUR segments run in order,
 * each processing to empty, each isolated - a failing segment never blocks
 * the segments after it.
 *
 *   1. schedules  - due points from `job_schedules`, session-lock single
 *                   flight, stale reclamation, CAS watermark, ledger row,
 *                   execute.
 *   2. queue      - `job_runs(status='queued')` claimed with
 *                   FOR UPDATE SKIP LOCKED, then the same lock -> reclaim ->
 *                   claim -> execute pipeline.
 *   3. deliveries - `webhook_deliveries(status='queued', next_attempt_at <=
 *                   now())` signed with Standard Webhooks headers and POSTed;
 *                   retryable failures stay queued with exponential backoff,
 *                   permanent ones turn terminal, 410 disables the endpoint.
 *   4. notifications - `notification_deliveries` claimed the same way
 *                   and handed to the email/Bark adapters; 1m/5m/15m retries
 *                   then terminal `failed`.
 *
 * All imports must stay Node-type-strippable (explicit `.ts` extensions, no
 * aliases, no SvelteKit virtual modules) because `jobs/drain.ts` runs under
 * plain `node`.
 */

/** Standard Webhooks recommends 15-30s; each delivery holds its row while sending. */
const DELIVERY_TIMEOUT_MS = 15_000;

/** `error` marker for dangling rows reclaimed by a later tick. */
const STALE_ERROR = 'stale';

/** Thrown by the cooperative timeout wrapper; see `withTimeout`. */
class JobTimeoutError extends Error {}

/**
 * Thrown when a timed-out job forces the whole tick to stop: a timed-out
 * promise cannot be cancelled, so the process is the only thing that can stop
 * it - the entry exits hard on this signal (a continuing tick would break the
 * "live execution <=> lock holder" reclaim contract once the lock is back).
 */
class DrainAbortedError extends Error {}

/** Queued rows inspected per claim round; rounded pages loop until empty. */
const QUEUE_BATCH = 20;

/** Wall-clock budget for one delivery segment. */
const DELIVERY_SEGMENT_BUDGET_MS = 45_000;

export interface DrainDeps {
	db: JobsDb;
	/** Try to take the job's session advisory lock; null means it is held elsewhere. */
	acquireLock(job: string): Promise<(() => Promise<void>) | null>;
	loadJob(name: string): Promise<LoadedJob>;
	/**
	 * Merged job metadata (registry ∪ user layer). Defaults to the
	 * registry-only lookup so non-drain callers keep the earlier contract.
	 */
	resolveJob?(name: string): Promise<JobDefinition | null>;
	now?: () => Date;
	log?: (line: string) => void;
	fetch?: typeof fetch;
	heartbeatUrl?: string | null;
}

export interface DrainSummary {
	schedules: {
		checked: number;
		bootstrapped: number;
		fired: number;
		busy: number;
		casLost: number;
		unknownJob: number;
		errors: number;
	};
	queue: { claimed: number; busy: number; errors: number };
	deliveries: {
		sent: number;
		failed: number;
		retried: number;
		skippedDisabled: number;
		errors: number;
	};
	/** Notification outbox segment (email / Bark). */
	notifications: {
		sent: number;
		failed: number;
		retried: number;
		skipped: number;
		errors: number;
	};
	/** Segment-level failures; the entry process exits non-zero when non-empty. */
	segmentErrors: string[];
	/** Set when a job timeout aborted the tick (the entry exits hard). */
	aborted: boolean;
	heartbeat: 'sent' | 'failed' | 'skipped';
}

type ResolvedDeps = Required<DrainDeps>;

interface RunTarget {
	id: string;
	job: string;
	trigger: JobTrigger;
	catchup: { missed: number; latestDue: Date } | null;
}

export async function runDrain(deps: DrainDeps): Promise<DrainSummary> {
	const resolved: ResolvedDeps = {
		db: deps.db,
		acquireLock: deps.acquireLock,
		loadJob: deps.loadJob,
		resolveJob:
			deps.resolveJob ?? (async (name) => (Object.hasOwn(JOBS, name) ? JOBS[name] : null)),
		now: deps.now ?? (() => new Date()),
		log: deps.log ?? (() => {}),
		fetch: deps.fetch ?? fetch,
		heartbeatUrl: deps.heartbeatUrl ?? null
	};
	const stats: DrainSummary = {
		schedules: {
			checked: 0,
			bootstrapped: 0,
			fired: 0,
			busy: 0,
			casLost: 0,
			unknownJob: 0,
			errors: 0
		},
		queue: { claimed: 0, busy: 0, errors: 0 },
		deliveries: { sent: 0, failed: 0, retried: 0, skippedDisabled: 0, errors: 0 },
		notifications: { sent: 0, failed: 0, retried: 0, skipped: 0, errors: 0 },
		segmentErrors: [],
		aborted: false,
		heartbeat: 'skipped'
	};

	const segments: Array<[string, (d: ResolvedDeps, s: DrainSummary) => Promise<void>]> = [
		['schedules', runScheduleSegment],
		['queue', runQueueSegment],
		['deliveries', runDeliverySegment],
		['notifications', runNotificationSegment]
	];
	for (const [name, run] of segments) {
		try {
			await run(resolved, stats);
		} catch (err) {
			stats.segmentErrors.push(`${name}: ${errorText(err)}`);
			if (err instanceof DrainAbortedError) {
				// A stuck job still runs inside this process; stop the tick.
				stats.aborted = true;
				resolved.log(`[drain] ${name} segment aborted: ${errorText(err)}`);
				break;
			}
			// Segment isolation: a failing segment never blocks the
			// segments after it.
			resolved.log(`[drain] ${name} segment failed: ${errorText(err)}`);
		}
	}

	if (resolved.heartbeatUrl && !tickDegraded(stats)) {
		try {
			await resolved.fetch(resolved.heartbeatUrl, { signal: AbortSignal.timeout(10_000) });
			stats.heartbeat = 'sent';
		} catch (err) {
			stats.heartbeat = 'failed';
			resolved.log(`[drain] heartbeat ping failed: ${errorText(err)}`);
		}
	} else if (resolved.heartbeatUrl) {
		// A push monitor reads "no ping" as failure - degraded ticks must NOT
		// report themselves healthy.
		resolved.log('[drain] heartbeat skipped: tick ended with errors');
	}

	resolved.log(
		`[drain] tick done: schedules ${stats.schedules.checked} checked / ${stats.schedules.fired} fired` +
			(stats.schedules.busy > 0 ? ` / ${stats.schedules.busy} busy` : '') +
			(stats.schedules.casLost > 0 ? ` / ${stats.schedules.casLost} cas-lost` : '') +
			(stats.schedules.unknownJob > 0 ? ` / ${stats.schedules.unknownJob} unknown-job` : '') +
			(stats.schedules.errors > 0 ? ` / ${stats.schedules.errors} errored` : '') +
			` | queue ${stats.queue.claimed} claimed` +
			(stats.queue.busy > 0 ? ` / ${stats.queue.busy} busy` : '') +
			(stats.queue.errors > 0 ? ` / ${stats.queue.errors} errored` : '') +
			` | deliveries ${stats.deliveries.sent} sent / ${stats.deliveries.failed} failed` +
			(stats.deliveries.retried > 0 ? ` / ${stats.deliveries.retried} retried` : '') +
			(stats.deliveries.skippedDisabled > 0
				? ` / ${stats.deliveries.skippedDisabled} disabled`
				: '') +
			(stats.deliveries.errors > 0 ? ` / ${stats.deliveries.errors} errored` : '') +
			` | notifications ${stats.notifications.sent} sent / ${stats.notifications.failed} failed` +
			(stats.notifications.retried > 0 ? ` / ${stats.notifications.retried} retried` : '') +
			(stats.notifications.skipped > 0 ? ` / ${stats.notifications.skipped} skipped` : '') +
			(stats.notifications.errors > 0 ? ` / ${stats.notifications.errors} errored` : '') +
			(stats.segmentErrors.length > 0 ? ` | segment errors: ${stats.segmentErrors.length}` : '')
	);
	return stats;
}

/** Anything that makes a tick unhealthy: no heartbeat ping on degraded ticks. */
function tickDegraded(stats: DrainSummary): boolean {
	return (
		stats.aborted ||
		stats.segmentErrors.length > 0 ||
		stats.schedules.errors > 0 ||
		stats.queue.errors > 0 ||
		// A failed delivery (missing/undecryptable signing secret) means an
		// event was dropped: the heartbeat must not stay green.
		stats.deliveries.errors > 0 ||
		stats.deliveries.failed > 0 ||
		// Same rule for a notification that reached its terminal failure: the
		// operator's inbox missed an event, and the tick is not healthy.
		stats.notifications.errors > 0 ||
		stats.notifications.failed > 0
	);
}

// ---------------------------------------------------------------------------
// Segment 1: schedules
// ---------------------------------------------------------------------------

async function runScheduleSegment(deps: ResolvedDeps, stats: DrainSummary): Promise<void> {
	const schedules = await deps.db
		.select()
		.from(jobSchedules)
		.where(eq(jobSchedules.isEnabled, true))
		.orderBy(asc(jobSchedules.createdAt));
	stats.schedules.checked = schedules.length;
	for (const schedule of schedules) {
		try {
			await runOneSchedule(deps, schedule, stats);
		} catch (err) {
			if (err instanceof DrainAbortedError) throw err;
			// Per-row isolation: one broken schedule (bad cron/tz) never
			// blocks the others.
			stats.schedules.errors += 1;
			deps.log(`[drain] schedule ${schedule.id} (${schedule.job}) errored: ${errorText(err)}`);
		}
	}
}

async function runOneSchedule(
	deps: ResolvedDeps,
	schedule: typeof jobSchedules.$inferSelect,
	stats: DrainSummary
): Promise<void> {
	const definition = await deps.resolveJob(schedule.job);
	if (!definition) {
		stats.schedules.unknownJob += 1;
		deps.log(
			`[drain] schedule ${schedule.id}: unknown job "${schedule.job}" - skipped, watermark untouched`
		);
		return;
	}
	const now = deps.now();
	if (schedule.lastDueAt === null) {
		// Bootstrap only: rows that arrive without a watermark (direct SQL,
		// future imports) start counting from now - never fire for the past
		// (an enable action resets the watermark too). `updatedAt` is pinned so a
		// routine watermark move
		// does not count as a config edit.
		const bootstrapped = await deps.db
			.update(jobSchedules)
			.set({ lastDueAt: now, updatedAt: schedule.updatedAt })
			.where(and(eq(jobSchedules.id, schedule.id), isNull(jobSchedules.lastDueAt)))
			.returning({ id: jobSchedules.id });
		if (bootstrapped.length > 0) {
			stats.schedules.bootstrapped += 1;
			deps.log(`[drain] schedule ${schedule.id} (${schedule.job}): water level initialized to now`);
		}
		return;
	}
	const snapshot = dueWindow(schedule.cronExpr, schedule.tz, schedule.lastDueAt, now);
	if (!snapshot) return;

	const ran = await runWithJobLock(deps, schedule.job, async () => {
		// Watermark advance + ledger row commit in ONE transaction - a crash
		// can never leave the watermark moved with no run recorded for it.
		// The CAS predicate is MONOTONIC (`watermark < new due`) PLUS a CONFIG
		// SNAPSHOT (cron/tz/enabled exactly as read at segment start).
		// Monotonic-only was the hole: `schedule` can be minutes
		// old here (rows run inline), so an admin edit mid-tick would still
		// match - clobbering the admin's watermark reset and firing once under
		// the old expression. Equality alone is not an option either:
		// watermarks written outside drizzle carry microseconds and would
		// silently stop the schedule from ever firing - monotonicity stays as
		// the concurrency half. Two drains racing the same
		// due: the second sees `latestDue < latestDue` false; an admin edit:
		// the snapshot columns mismatch. `updatedAt` is pinned: a watermark
		// move is not a config edit.
		const runId = await deps.db.transaction(async (tx) => {
			const advanced = await tx
				.update(jobSchedules)
				.set({ lastDueAt: snapshot.latestDue, updatedAt: schedule.updatedAt })
				.where(
					and(
						eq(jobSchedules.id, schedule.id),
						lt(jobSchedules.lastDueAt, snapshot.latestDue),
						eq(jobSchedules.cronExpr, schedule.cronExpr),
						eq(jobSchedules.tz, schedule.tz),
						eq(jobSchedules.isEnabled, true)
					)
				)
				.returning({ id: jobSchedules.id });
			if (advanced.length === 0) return null;
			const inserted = await tx
				.insert(jobRuns)
				.values({ job: schedule.job, trigger: 'schedule', status: 'running', startedAt: now })
				.returning({ id: jobRuns.id });
			return inserted[0].id;
		});
		if (runId === null) {
			stats.schedules.casLost += 1;
			deps.log(
				`[drain] ${schedule.job}: watermark advance lost (concurrent drain or config changed mid-tick)`
			);
			return;
		}
		stats.schedules.fired += 1;
		await executeRun(deps, {
			id: runId,
			job: schedule.job,
			trigger: 'schedule',
			catchup:
				snapshot.dues > 1 ? { missed: snapshot.dues - 1, latestDue: snapshot.latestDue } : null
		});
	});
	if (!ran) {
		// Lock held (a long run is in flight): no watermark move, no row -
		// retry next tick.
		stats.schedules.busy += 1;
		deps.log(`[drain] ${schedule.job}: busy (lock held), due point left for the next tick`);
	}
}

// ---------------------------------------------------------------------------
// Segment 2: queued runs
// ---------------------------------------------------------------------------

async function runQueueSegment(deps: ResolvedDeps, stats: DrainSummary): Promise<void> {
	// Every round either claims rows (they leave `queued`) or adds them to
	// `skipped` (lock busy / row-level error), so the candidate set shrinks
	// monotonically and the segment truly loops to empty - a page full of
	// lock-busy rows no longer hides the rows behind it.
	const skipped = new Set<string>();
	for (;;) {
		const candidates = await deps.db
			.select({ id: jobRuns.id, job: jobRuns.job, trigger: jobRuns.trigger })
			.from(jobRuns)
			.where(
				and(
					eq(jobRuns.status, 'queued'),
					skipped.size > 0 ? notInArray(jobRuns.id, [...skipped]) : undefined
				)
			)
			.orderBy(asc(jobRuns.createdAt))
			.limit(QUEUE_BATCH)
			.for('update', { skipLocked: true });
		if (candidates.length === 0) break;
		for (const candidate of candidates) {
			try {
				const ran = await runWithJobLock(deps, candidate.job, async () => {
					const now = deps.now();
					const claimed = await claimQueuedRun(deps, candidate.id, now);
					if (!claimed) return; // another drain claimed it between select and update
					stats.queue.claimed += 1;
					await executeRun(deps, {
						id: candidate.id,
						job: candidate.job,
						trigger: candidate.trigger as JobTrigger,
						catchup: null
					});
				});
				if (!ran) {
					skipped.add(candidate.id);
					stats.queue.busy += 1;
					deps.log(`[drain] ${candidate.job}: busy (lock held), queued run left for the next tick`);
				}
			} catch (err) {
				if (err instanceof DrainAbortedError) throw err;
				// Excluded from further pages too, or a permanently failing row
				// would spin this loop forever.
				skipped.add(candidate.id);
				stats.queue.errors += 1;
				deps.log(
					`[drain] queued run ${candidate.id} (${candidate.job}) errored: ${errorText(err)}`
				);
			}
		}
	}
}

/**
 * Move one queued row to `running` under a row lock. The locked re-select is
 * what makes SKIP LOCKED exclusionary (the earlier candidate scan runs in
 * autocommit and releases its row locks at statement end); the status re-check
 * keeps the claim idempotent.
 */
async function claimQueuedRun(deps: ResolvedDeps, runId: string, now: Date): Promise<boolean> {
	return deps.db.transaction(async (tx) => {
		const [row] = await tx
			.select({ id: jobRuns.id })
			.from(jobRuns)
			.where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'queued')))
			.for('update', { skipLocked: true });
		if (!row) return false;
		await tx
			.update(jobRuns)
			.set({ status: 'running', startedAt: now })
			.where(eq(jobRuns.id, runId));
		return true;
	});
}

// ---------------------------------------------------------------------------
// Shared execution pipeline
// ---------------------------------------------------------------------------

/**
 * Shared execution shell for both entry paths (order contract):
 * try-lock -> reclaim -> body -> release. Returns false when the lock is
 * busy. On a tick abort the lock is deliberately kept: the hard exit takes
 * the whole session (and its locks) down with the stuck job, so no other
 * drain starts a second copy meanwhile.
 */
async function runWithJobLock(
	deps: ResolvedDeps,
	job: string,
	body: () => Promise<void>
): Promise<boolean> {
	const release = await deps.acquireLock(job);
	if (!release) return false;
	let holdLockUntilExit = false;
	try {
		const reclaimed = await reclaimStaleRuns(deps, job);
		if (reclaimed > 0) {
			deps.log(`[drain] ${job}: reclaimed ${reclaimed} stale running row(s)`);
		}
		await body();
	} catch (err) {
		if (err instanceof DrainAbortedError) holdLockUntilExit = true;
		throw err;
	} finally {
		if (!holdLockUntilExit) await release();
	}
	return true;
}

/**
 * Reclaim dangling `running` rows (order contract): MUST only run
 * while holding the job's session lock - with the lock in hand every
 * `running` row for the job belongs to a dead or already-finished owner, and
 * never to a live execution, because live executions hold the lock.
 */
async function reclaimStaleRuns(deps: ResolvedDeps, job: string): Promise<number> {
	const rows = await deps.db
		.update(jobRuns)
		// `finished_at` stays NULL on purpose: the run never completed and the
		// reclaimer cannot know when it died - a fabricated `now` would turn
		// into a fake duration on the admin dashboard. `error = 'stale'` is the
		// marker that this row was reclaimed.
		.set({ status: 'failed', error: STALE_ERROR })
		.where(and(eq(jobRuns.job, job), eq(jobRuns.status, 'running')))
		.returning({ id: jobRuns.id });
	// A reclaimed run is a TERMINAL failure like any other: the whitelist gets
	// the same one-alert-per-run treatment (otherwise a job that crashes the
	// process - the case the alert matters most for - would be silent).
	for (const row of rows) {
		await raiseJobFailureAlert(deps, {
			runId: row.id,
			job,
			error: 'stale (the run was reclaimed after its process died)'
		});
	}
	return rows.length;
}

async function executeRun(deps: ResolvedDeps, target: RunTarget): Promise<void> {
	const definition = await deps.resolveJob(target.job);
	if (!definition) {
		// The name can vanish between enqueue and claim (e.g. a user job was
		// deleted); record the failure instead of crashing on undefined.
		await finalizeRun(
			deps,
			target.id,
			target.job,
			'failed',
			null,
			{},
			`unknown job "${target.job}"`
		);
		deps.log(`[drain] ${target.job} run ${target.id}: failed - unknown job`);
		return;
	}
	const summaryData: JobResult = {};
	const logger = createLogger(deps.log, target.job);
	try {
		const loaded = await deps.loadJob(target.job);
		await deps.db
			.update(jobRuns)
			.set({ sourceHash: loaded.sourceHash })
			.where(eq(jobRuns.id, target.id));
		const ctx: JobContext = {
			job: target.job,
			trigger: target.trigger,
			db: deps.db,
			logger,
			summary: (data) => Object.assign(summaryData, data)
		};
		// Bind the client for the duration of the run so bare SDK calls
		// (`getOption`, `db`) resolve without threading ctx.db.
		bindJobDb(deps.db);
		try {
			await withTimeout(Promise.resolve(loaded.run(ctx)), definition.timeoutMs, target.job);
		} finally {
			bindJobDb(null);
		}
		await finalizeRun(deps, target.id, target.job, 'succeeded', target.catchup, summaryData, null);
		deps.log(`[drain] ${target.job} run ${target.id}: succeeded`);
	} catch (err) {
		await finalizeRun(
			deps,
			target.id,
			target.job,
			'failed',
			target.catchup,
			summaryData,
			errorText(err)
		);
		deps.log(`[drain] ${target.job} run ${target.id}: failed - ${errorText(err)}`);
		if (err instanceof JobTimeoutError) {
			// The timed-out job is still running inside this process (Promise
			// races cannot cancel). Continuing the tick would break the
			// "running row <=> lock holder" reclaim contract the moment the
			// lock is released, so the tick aborts and the entry exits hard.
			throw new DrainAbortedError(`${target.job}: timed out and is still running; tick aborted`);
		}
	}
}

async function finalizeRun(
	deps: ResolvedDeps,
	runId: string,
	job: string,
	status: 'succeeded' | 'failed',
	catchup: RunTarget['catchup'],
	summaryData: JobResult,
	error: string | null
): Promise<void> {
	const result: JobResult = { ...summaryData };
	if (catchup) {
		result.catchup = true;
		result.missed = catchup.missed;
	}
	await deps.db
		.update(jobRuns)
		.set({
			status,
			result: Object.keys(result).length > 0 ? result : null,
			error,
			finishedAt: deps.now()
		})
		.where(eq(jobRuns.id, runId));
	if (status === 'failed') await raiseJobFailureAlert(deps, { runId, job, error });
}

/**
 * `job.failed` producer.
 *
 * Fires ONCE per terminal run (the outbox key `job_run:<id>` absorbs retries
 * and a re-finalized row), and only for the whitelist: a nightly maintenance
 * job going red is already visible in the run ledger and on the drain
 * heartbeat, and mailing every day would train the operator to ignore the
 * channel. Routing goes through the `notify()` seam so the outbox writer
 * installed by the entry is the single delivery path; without a sink (unit
 * tests, a CLI run) it degrades to the seam's log line.
 *
 * Never throws: the run ledger row is already committed, and a notification
 * failure must not turn a recorded failure into a tick-level error.
 */
async function raiseJobFailureAlert(
	deps: ResolvedDeps,
	input: { runId: string; job: string; error: string | null }
): Promise<void> {
	if (!shouldAlertJobFailure(input.job)) return;
	try {
		const origin = process.env.ORIGIN?.trim();
		const delivered = await defaultNotify({
			eventType: 'job.failed',
			eventKey: `job_run:${input.runId}`,
			title: `Job ${input.job} failed`,
			body: input.error ?? 'the run failed without an error message',
			url: origin ? `${origin.replace(/\/$/, '')}/admin/jobs` : null
		});
		if (delivered !== 'delivered') {
			deps.log(`[drain] job.failed alert for ${input.job} run ${input.runId}: ${delivered}`);
		}
	} catch (err) {
		// notify() already swallows sink errors; this guards a future change.
		deps.log(`[drain] job.failed alert failed: ${errorText(err)}`);
	}
}

/**
 * Cooperative timeout: races the job promise against a deadline. The job
 * keeps running after a timeout (there is no way to cancel a JS promise) -
 * executeRun turns a JobTimeoutError into a tick abort so the stuck job dies
 * with the hard-exiting process.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, job: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new JobTimeoutError(`job "${job}" timed out after ${timeoutMs}ms`)),
					timeoutMs
				);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

function createLogger(log: (line: string) => void, job: string): JobLogger {
	const emit = (level: string, message: string, meta?: Record<string, unknown>) => {
		log(`[jobs] ${job} ${level}: ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
	};
	return {
		info: (message, meta) => emit('info', message, meta),
		warn: (message, meta) => emit('warn', message, meta),
		error: (message, meta) => emit('error', message, meta)
	};
}

// ---------------------------------------------------------------------------
// Segment 3: webhook deliveries
// ---------------------------------------------------------------------------

async function runDeliverySegment(deps: ResolvedDeps, stats: DrainSummary): Promise<void> {
	// Bounded like the runs segment (QUEUE_BATCH) PLUS a wall-clock budget: a
	// black-holed receiver costs up to DELIVERY_TIMEOUT_MS per row, so the
	// count cap alone could still run QUEUE_BATCH x 15s; the deadline keeps a
	// tick near one interval. Leftovers are picked up by
	// the next tick (FOR UPDATE SKIP LOCKED keeps concurrent ticks safe).
	const deadline = deps.now().getTime() + DELIVERY_SEGMENT_BUDGET_MS;
	let processed = 0;
	for (;;) {
		if (processed >= QUEUE_BATCH || deps.now().getTime() >= deadline) break;
		let outcome: DeliveryOutcome | null;
		try {
			outcome = await deliverOne(deps);
		} catch (err) {
			// A failing claim is a BROKEN segment, not a per-delivery outcome:
			// record it as segment-level so the entry exits non-zero and the
			// heartbeat stays quiet (platform alerting reads both).
			stats.deliveries.errors += 1;
			stats.segmentErrors.push(`deliveries: ${errorText(err)}`);
			deps.log(`[drain] delivery segment error: ${errorText(err)}`);
			break; // do not spin on a failing claim; the next tick retries
		}
		if (outcome === null) break;
		// Counters move only after the transaction COMMITTED - an aborted
		// transaction must not leave phantom numbers in the tick summary.
		if (outcome === 'sent') stats.deliveries.sent += 1;
		else if (outcome === 'disabled') stats.deliveries.skippedDisabled += 1;
		else if (outcome === 'retried') stats.deliveries.retried += 1;
		else stats.deliveries.failed += 1;
		processed += 1;
	}
}

type DeliveryOutcome = 'sent' | 'failed' | 'retried' | 'disabled';

/**
 * Claim + send + finalize ONE delivery attempt inside a single transaction:
 * the row lock makes concurrent drains skip it, and a crash rolls the status
 * back to `queued` so the next tick retries with the SAME row id.
 *
 * Retryable outcomes (network/timeout, 408, 429, 5xx) put the row back
 * to `queued` with `attemptCount + 1` and `nextAttemptAt` in the future;
 * permanent outcomes (3xx, other 4xx, exhausted budget, blocked target) mark
 * it `failed`. The id never changes, so `webhook-id` is stable across every
 * attempt and manual replays.
 *
 * NB (registered): if the receiver answered 2xx but the COMMIT then fails,
 * the row falls back to queued and the next tick resends - stable
 * `webhook-id` lets receivers deduplicate (at-least-once window).
 *
 * Returns null when there is nothing due to send.
 */
async function deliverOne(deps: ResolvedDeps): Promise<DeliveryOutcome | null> {
	const now = deps.now();
	return deps.db.transaction(async (tx) => {
		const [delivery] = await tx
			.select({
				id: webhookDeliveries.id,
				webhookId: webhookDeliveries.webhookId,
				payload: webhookDeliveries.payload,
				attemptCount: webhookDeliveries.attemptCount
			})
			.from(webhookDeliveries)
			.where(and(eq(webhookDeliveries.status, 'queued'), lte(webhookDeliveries.nextAttemptAt, now)))
			.orderBy(asc(webhookDeliveries.createdAt))
			.limit(1)
			.for('update', { skipLocked: true });
		if (!delivery) return null;

		const [endpoint] = await tx
			.select({
				id: webhooks.id,
				name: webhooks.name,
				payloadUrl: webhooks.payloadUrl,
				isEnabled: webhooks.isEnabled
			})
			.from(webhooks)
			.where(eq(webhooks.id, delivery.webhookId))
			.limit(1);
		if (!endpoint) {
			// Unreachable by construction: webhook_id is NOT NULL with an
			// ON DELETE CASCADE FK, and we hold the delivery's row lock, so
			// the endpoint cannot vanish mid-flight. Keep it loud rather than
			// inventing a status for an impossible state.
			throw new Error(
				`webhook endpoint ${delivery.webhookId} missing while holding the delivery lock`
			);
		}
		if (!endpoint.isEnabled) {
			await tx
				.update(webhookDeliveries)
				.set({ status: 'failed', error: 'endpoint disabled', deliveredAt: now })
				.where(eq(webhookDeliveries.id, delivery.id));
			return 'disabled';
		}
		if (delivery.payload === null) {
			// Unreachable by construction (the outbox always writes the shaped
			// {type,timestamp,data} body); a NULL row must not degrade into a
			// silently unshaped `{}` POST - record it loudly instead.
			await tx
				.update(webhookDeliveries)
				.set({
					status: 'failed',
					responseCode: null,
					error: 'payload missing',
					deliveredAt: now
				})
				.where(eq(webhookDeliveries.id, delivery.id));
			return 'failed';
		}

		const body = JSON.stringify(delivery.payload);
		// Refuse a stored target that is (or now resolves) private. Rows
		// created before the guard existed would otherwise keep posting to the
		// metadata service. A blocked target is permanent - retrying cannot fix
		// the URL, so there is no retry schedule for it.
		try {
			await assertDeliveryTarget(endpoint.payloadUrl, {
				...webhookGuardOptionsFromEnv((name) => process.env[name])
			});
		} catch (error) {
			if (!(error instanceof WebhookUrlError)) throw error;
			await tx
				.update(webhookDeliveries)
				.set({
					status: 'failed',
					responseCode: null,
					error: `blocked target (${error.reason})`,
					deliveredAt: now
				})
				.where(eq(webhookDeliveries.id, delivery.id));
			deps.log(`[drain] webhook ${endpoint.id}: blocked target (${error.reason}), delivery failed`);
			return 'failed';
		}
		const timestampSeconds = Math.floor(now.getTime() / 1000);
		/** Persist one attempt: queued for a retry, or terminal failed. */
		const finishAttempt = async (input: {
			attemptsMade: number;
			responseCode: number | null;
			error: string;
			at: Date;
			retryAfterMs?: number | null;
		}): Promise<DeliveryOutcome> => {
			const plan = planWebhookRetry(input.attemptsMade, {
				retryAfterMs: input.retryAfterMs ?? null
			});
			if (plan.retry) {
				await tx
					.update(webhookDeliveries)
					.set({
						status: 'queued',
						attemptCount: input.attemptsMade,
						nextAttemptAt: new Date(input.at.getTime() + plan.delayMs),
						responseCode: input.responseCode,
						error: input.error,
						deliveredAt: null
					})
					.where(eq(webhookDeliveries.id, delivery.id));
				return 'retried';
			}
			await tx
				.update(webhookDeliveries)
				.set({
					status: 'failed',
					attemptCount: input.attemptsMade,
					nextAttemptAt: input.at,
					responseCode: input.responseCode,
					error: input.error,
					deliveredAt: input.at
				})
				.where(eq(webhookDeliveries.id, delivery.id));
			return 'failed';
		};
		// Signing secrets are encrypted at rest. A typed failure here is
		// a per-delivery outcome, not a segment crash: the row records why it
		// could not be signed and the next tick follows the normal retry rule.
		let signing;
		try {
			signing = await resolveWebhookSigningSecrets(
				tx as unknown as SecretDb,
				endpoint.id,
				{ getEnv: (name) => process.env[name] },
				now
			);
		} catch (err) {
			const reason = isSecretError(err) ? err.code : 'store_unavailable';
			if (isSecretError(err)) {
				await reportSecretFailure(tx as never, {
					event: err.code === 'missing' ? 'webhook.key_missing' : 'webhook.key_decrypt_failed',
					providerName: endpoint.name,
					subject: endpoint.id,
					reason: err.code
				});
			}
			// Only a transient store outage pauses the segment. A retired key
			// version is terminal for THIS row: throwing here would roll back
			// the tx, leave attempt_count at 0, and re-select the same oldest
			// row forever, blocking every newer delivery.
			if (reason === 'store_unavailable') {
				throw new Error(`signing secret unavailable for webhook ${endpoint.id} (${reason})`, {
					cause: err
				});
			}
			await tx
				.update(webhookDeliveries)
				.set({
					status: 'failed',
					attemptCount: delivery.attemptCount + 1,
					nextAttemptAt: now,
					responseCode: null,
					error: `signing secret unavailable (${reason})`,
					deliveredAt: now
				})
				.where(eq(webhookDeliveries.id, delivery.id));
			deps.log(`[drain] webhook ${endpoint.id}: signing secret unavailable (${reason})`);
			return 'failed';
		}
		const headers = webhookHeaders(
			signing.current,
			delivery.id,
			timestampSeconds,
			body,
			signing.previous ? [signing.previous] : []
		);
		try {
			const response = await deps.fetch(endpoint.payloadUrl, {
				method: 'POST',
				headers: { ...headers, 'content-type': 'application/json' },
				body,
				// 3xx is a failure per spec - never follow redirects.
				redirect: 'manual',
				signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
			});
			// The terminal stamp is the attempt-CLOSE time, not the claim time
			// (nine-dimension DB-03: a slow POST must not record ~0 latency).
			const finishedAt = deps.now();
			const attemptsMade = delivery.attemptCount + 1;
			const responseClass = classifyWebhookResponse(response.status);
			if (responseClass === 'success') {
				await tx
					.update(webhookDeliveries)
					.set({
						status: 'succeeded',
						attemptCount: attemptsMade,
						nextAttemptAt: finishedAt,
						responseCode: response.status,
						error: null,
						deliveredAt: finishedAt
					})
					.where(eq(webhookDeliveries.id, delivery.id));
				return 'sent';
			}
			if (responseClass === 'disable') {
				// Standard Webhooks: 410 Gone means "stop sending" - disable
				// the endpoint so future events do not queue deliveries for it.
				await tx
					.update(webhookDeliveries)
					.set({
						status: 'failed',
						attemptCount: attemptsMade,
						nextAttemptAt: finishedAt,
						responseCode: response.status,
						error: 'HTTP 410',
						deliveredAt: finishedAt
					})
					.where(eq(webhookDeliveries.id, delivery.id));
				await tx.update(webhooks).set({ isEnabled: false }).where(eq(webhooks.id, endpoint.id));
				await recordWebhookAutoDisable(tx, { webhookId: endpoint.id, name: endpoint.name });
				deps.log(`[drain] webhook endpoint ${endpoint.id}: 410 Gone, endpoint disabled`);
				return 'failed';
			}
			if (responseClass === 'permanent') {
				// 3xx (never followed) and 4xx other than 408/429: retrying
				// cannot succeed, so the row turns terminal immediately.
				await tx
					.update(webhookDeliveries)
					.set({
						status: 'failed',
						attemptCount: attemptsMade,
						nextAttemptAt: finishedAt,
						responseCode: response.status,
						error: `HTTP ${response.status}`,
						deliveredAt: finishedAt
					})
					.where(eq(webhookDeliveries.id, delivery.id));
				return 'failed';
			}
			const outcome = await finishAttempt({
				attemptsMade,
				responseCode: response.status,
				error: `HTTP ${response.status}`,
				at: finishedAt,
				// 429/503 may carry the receiver's own backoff; the longer
				// delay wins (clamped by the retry policy).
				retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), finishedAt)
			});
			if (outcome === 'retried') {
				deps.log(
					`[drain] webhook ${endpoint.id}: HTTP ${response.status}, ` +
						`attempt ${attemptsMade} failed, retry scheduled`
				);
			}
			return outcome;
		} catch (err) {
			const finishedAt = deps.now();
			const outcome = await finishAttempt({
				attemptsMade: delivery.attemptCount + 1,
				responseCode: null,
				error: errorText(err),
				at: finishedAt
			});
			if (outcome === 'retried') {
				deps.log(
					`[drain] webhook ${endpoint.id}: transport error, ` +
						`attempt ${delivery.attemptCount + 1} failed, retry scheduled`
				);
			}
			return outcome;
		}
	});
}

// ---------------------------------------------------------------------------
// Segment 4: notification deliveries
// ---------------------------------------------------------------------------

/**
 * Wall-clock budget for the notification segment. Same shape as the webhook
 * segment: at most QUEUE_BATCH rows AND at most ~45s, so one black-holed SMTP
 * handshake cannot stretch a tick past its interval. Leftovers are picked up
 * by the next tick (FOR UPDATE SKIP LOCKED keeps concurrent ticks safe).
 */
const NOTIFICATION_SEGMENT_BUDGET_MS = 45_000;

async function runNotificationSegment(deps: ResolvedDeps, stats: DrainSummary): Promise<void> {
	const deadline = deps.now().getTime() + NOTIFICATION_SEGMENT_BUDGET_MS;
	let processed = 0;
	for (;;) {
		if (processed >= QUEUE_BATCH || deps.now().getTime() >= deadline) break;
		let outcome: NotificationDeliveryOutcome | null;
		try {
			outcome = await deliverNotification(deps.db, {
				now: deps.now,
				log: deps.log,
				getEnv: (name) => process.env[name],
				fetch: deps.fetch
			});
		} catch (err) {
			// A failing claim is a BROKEN segment, not a per-delivery outcome:
			// record it at segment level so the entry exits non-zero and the
			// heartbeat stays quiet.
			stats.notifications.errors += 1;
			stats.segmentErrors.push(`notifications: ${errorText(err)}`);
			deps.log(`[notify] segment error: ${errorText(err)}`);
			break; // do not spin on a failing claim; the next tick retries
		}
		if (outcome === null) break;
		// Counters move only after the transaction COMMITTED.
		if (outcome === 'sent') stats.notifications.sent += 1;
		else if (outcome === 'retried') stats.notifications.retried += 1;
		else if (outcome === 'failed') stats.notifications.failed += 1;
		else stats.notifications.skipped += 1;
		processed += 1;
	}
}

// ---------------------------------------------------------------------------
// Error text hygiene
// ---------------------------------------------------------------------------

// sanitizeErrorText moved to ./error-text.ts (keeps the strip-only builtin
// chain lean); re-exported for the existing drain consumers and tests.
export { sanitizeErrorText } from './error-text.ts';

function errorText(err: unknown): string {
	const code = pgErrorCode(err);
	if (code) {
		// Prefer the driver-level message (server text, no bound parameters)
		// over drizzle's wrapper text that embeds the SQL and its params.
		const driverMessage = driverMessageWithCode(err);
		return sanitizeErrorText(driverMessage ? `${code}: ${driverMessage}` : `${code}: query failed`);
	}
	const raw = err instanceof Error ? err.message || err.name : String(err);
	return sanitizeErrorText(raw);
}

function driverMessageWithCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let depth = 0; depth < 5 && current != null; depth++) {
		if (typeof current === 'object' && 'code' in current) {
			const { code, message } = current as { code?: unknown; message?: unknown };
			if (typeof code === 'string' && typeof message === 'string') return message;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}
