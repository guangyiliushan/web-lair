import { and, asc, eq } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import { jobSchedules } from '../db/system/job-schedule.schema.ts';
import { pgErrorCode } from '../db/pg-error.ts';
import { recordActivity } from '../audit.ts';
import { isPgAcceptableTimeZone, type PgTimeZoneExecutor } from '../pg-timezone.ts';
import { isValidIanaTimeZone } from '../../utils/timezone.ts';
import { assertCronExpr } from './due.ts';
import { resolveJobDefinition } from './user-layer.ts';

/**
 * Schedule management (J-3, plan §3.2/§5.7): the admin surface's cron CRUD.
 * Every mutation joins one transaction with its audit row (ledger §26 roster:
 * `schedule.create/update/delete/toggle`). Watermark rules follow §3.2 -
 * creating and re-enabling reset `last_due_at` to now (enabling is "start
 * from the next due point", never a catch-up over the disabled window), and
 * editing the cron or tz resets it too: the due grid moved, so a stale
 * watermark could otherwise fire an unintended catch-up under the new
 * expression.
 */

type ScheduleDb = Pick<
	typeof import('$lib/server/db').db,
	'select' | 'insert' | 'update' | 'delete' | 'transaction'
>;

export interface ScheduleListRow {
	id: string;
	job: string;
	cronExpr: string;
	tz: string;
	isEnabled: boolean;
	lastDueAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/** All schedules, ordered by job then creation time (the page groups inline). */
export async function listSchedules(db: ScheduleDb): Promise<ScheduleListRow[]> {
	return db
		.select({
			id: jobSchedules.id,
			job: jobSchedules.job,
			cronExpr: jobSchedules.cronExpr,
			tz: jobSchedules.tz,
			isEnabled: jobSchedules.isEnabled,
			lastDueAt: jobSchedules.lastDueAt,
			createdAt: jobSchedules.createdAt,
			updatedAt: jobSchedules.updatedAt
		})
		.from(jobSchedules)
		.orderBy(asc(jobSchedules.job), asc(jobSchedules.createdAt));
}

export type ScheduleValidation =
	{ ok: true; cronExpr: string; tz: string } | { ok: false; message: string };

/**
 * Cron + timezone gate (plan §4.9; timezone closure = ledger §13.9): exactly
 * five fields via the same checker the drain applies, an Intl probe, PG
 * `pg_timezone_names` membership, and a cron-parser trial parse with the tz
 * (cron-parser is what actually computes the due points, so it gets the last
 * word).
 */
export async function validateScheduleInput(
	input: { cronExpr: string; tz: string },
	executor?: PgTimeZoneExecutor
): Promise<ScheduleValidation> {
	const cronExpr = input.cronExpr.trim();
	const tz = input.tz.trim();
	if (!cronExpr) return { ok: false, message: 'cron 表达式不能为空' };
	if (!tz) return { ok: false, message: '时区不能为空' };
	try {
		assertCronExpr(cronExpr);
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'cron 表达式不合法' };
	}
	if (!isValidIanaTimeZone(tz)) return { ok: false, message: `无效的 IANA 时区名："${tz}"` };
	if (!(await isPgAcceptableTimeZone(tz, executor))) {
		return { ok: false, message: `PostgreSQL 不接受该时区："${tz}"` };
	}
	try {
		CronExpressionParser.parse(cronExpr, { tz });
	} catch {
		return { ok: false, message: `cron 表达式在时区 ${tz} 下无法解析` };
	}
	return { ok: true, cronExpr, tz };
}

export type CreateScheduleResult =
	| { kind: 'created'; id: string }
	| { kind: 'invalid'; message: string }
	| { kind: 'unknown-job'; message: string }
	| { kind: 'duplicate' };

/** Create one schedule row. The job must resolve (registry or user file). */
export async function createSchedule(input: {
	db: ScheduleDb;
	dataDir: string;
	job: string;
	cronExpr: string;
	tz: string;
	actorId: string | null;
}): Promise<CreateScheduleResult> {
	const job = input.job.trim();
	const definition = await resolveJobDefinition(job, input.dataDir);
	if (!definition) return { kind: 'unknown-job', message: `未知的任务："${job}"` };
	// The membership check rides on `execute`, which the ScheduleDb surface
	// does not name - same cast the options registry uses (ledger §13.9).
	const validation = await validateScheduleInput(input, input.db as unknown as PgTimeZoneExecutor);
	if (!validation.ok) return { kind: 'invalid', message: validation.message };
	try {
		return await input.db.transaction(async (tx) => {
			const [row] = await tx
				.insert(jobSchedules)
				.values({
					job,
					cronExpr: validation.cronExpr,
					tz: validation.tz,
					isEnabled: true,
					lastDueAt: new Date()
				})
				.returning({ id: jobSchedules.id });
			await recordActivity(tx, {
				event: 'schedule.create',
				actorId: input.actorId,
				payload: { id: row.id, job, cron_expr: validation.cronExpr, tz: validation.tz }
			});
			return { kind: 'created' as const, id: row.id };
		});
	} catch (error) {
		if (pgErrorCode(error) === '23505') return { kind: 'duplicate' };
		throw error;
	}
}

export type UpdateScheduleResult =
	| { kind: 'updated'; id: string; watermarkReset: boolean }
	| { kind: 'invalid'; message: string }
	| { kind: 'duplicate' }
	| { kind: 'not-found' };

/** Edit a schedule's cron/tz. A due-grid change resets the watermark. */
export async function updateSchedule(input: {
	db: ScheduleDb;
	id: string;
	cronExpr: string;
	tz: string;
	actorId: string | null;
}): Promise<UpdateScheduleResult> {
	const validation = await validateScheduleInput(input, input.db as unknown as PgTimeZoneExecutor);
	if (!validation.ok) return { kind: 'invalid', message: validation.message };
	const [existing] = await input.db
		.select({ job: jobSchedules.job, cronExpr: jobSchedules.cronExpr, tz: jobSchedules.tz })
		.from(jobSchedules)
		.where(eq(jobSchedules.id, input.id))
		.limit(1);
	if (!existing) return { kind: 'not-found' };
	const watermarkReset = existing.cronExpr !== validation.cronExpr || existing.tz !== validation.tz;
	try {
		const outcome = await input.db.transaction(async (tx) => {
			// `.returning` as the existence probe (J-3 review J3-2): a row
			// deleted between the read above and this write must answer
			// not-found, not a phantom success plus a stray audit row.
			const updated = await tx
				.update(jobSchedules)
				.set(
					watermarkReset
						? { cronExpr: validation.cronExpr, tz: validation.tz, lastDueAt: new Date() }
						: { cronExpr: validation.cronExpr, tz: validation.tz }
				)
				.where(eq(jobSchedules.id, input.id))
				.returning({ id: jobSchedules.id });
			if (updated.length === 0) return 'missing' as const;
			await recordActivity(tx, {
				event: 'schedule.update',
				actorId: input.actorId,
				payload: {
					id: input.id,
					job: existing.job,
					cron_expr: validation.cronExpr,
					tz: validation.tz,
					watermark_reset: watermarkReset
				}
			});
			return 'updated' as const;
		});
		if (outcome === 'missing') return { kind: 'not-found' };
	} catch (error) {
		if (pgErrorCode(error) === '23505') return { kind: 'duplicate' };
		throw error;
	}
	return { kind: 'updated', id: input.id, watermarkReset };
}

export type ToggleScheduleResult =
	{ kind: 'toggled'; id: string; enabled: boolean } | { kind: 'stale' } | { kind: 'not-found' };

/**
 * Set `is_enabled` to an EXPLICIT target state (never a blind flip): the UI
 * submits the desired end state, so a double-click / replayed POST is an
 * idempotent no-op instead of flipping the row back (J-3 review F2).
 * Enabling resets the watermark (plan §3.2); a concurrent writer that moved
 * the state in between answers `stale` (conditional write, no lost update).
 */
export async function toggleSchedule(input: {
	db: ScheduleDb;
	id: string;
	enabled: boolean;
	actorId: string | null;
}): Promise<ToggleScheduleResult> {
	const [existing] = await input.db
		.select({ job: jobSchedules.job, isEnabled: jobSchedules.isEnabled })
		.from(jobSchedules)
		.where(eq(jobSchedules.id, input.id))
		.limit(1);
	if (!existing) return { kind: 'not-found' };
	const enabled = input.enabled;
	if (existing.isEnabled === enabled) {
		// Idempotent replay: already in the requested state - no write, no
		// duplicate audit row.
		return { kind: 'toggled', id: input.id, enabled };
	}
	const outcome = await input.db.transaction(async (tx) => {
		const updated = await tx
			.update(jobSchedules)
			.set(enabled ? { isEnabled: true, lastDueAt: new Date() } : { isEnabled: false })
			.where(and(eq(jobSchedules.id, input.id), eq(jobSchedules.isEnabled, existing.isEnabled)))
			.returning({ id: jobSchedules.id });
		if (updated.length === 0) {
			// Distinguish vanished row from a racing flip for the caller.
			const [stillThere] = await tx
				.select({ id: jobSchedules.id })
				.from(jobSchedules)
				.where(eq(jobSchedules.id, input.id))
				.limit(1);
			return stillThere ? ('stale' as const) : ('missing' as const);
		}
		await recordActivity(tx, {
			event: 'schedule.toggle',
			actorId: input.actorId,
			payload: { id: input.id, job: existing.job, enabled }
		});
		return 'toggled' as const;
	});
	if (outcome === 'missing') return { kind: 'not-found' };
	if (outcome === 'stale') return { kind: 'stale' };
	return { kind: 'toggled', id: input.id, enabled };
}

export type DeleteScheduleResult = { kind: 'deleted'; id: string } | { kind: 'not-found' };

/** Hard-delete one schedule row (audited in the same transaction). */
export async function deleteSchedule(input: {
	db: ScheduleDb;
	id: string;
	actorId: string | null;
}): Promise<DeleteScheduleResult> {
	const removed = await input.db.transaction(async (tx) => {
		const deleted = await tx
			.delete(jobSchedules)
			.where(eq(jobSchedules.id, input.id))
			.returning({ id: jobSchedules.id, job: jobSchedules.job });
		if (deleted.length === 0) return null;
		await recordActivity(tx, {
			event: 'schedule.delete',
			actorId: input.actorId,
			payload: { id: deleted[0].id, job: deleted[0].job }
		});
		return deleted[0];
	});
	if (!removed) return { kind: 'not-found' };
	return { kind: 'deleted', id: removed.id };
}
