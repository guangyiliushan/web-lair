import { and, asc, eq, lte } from 'drizzle-orm';
import { user } from '../db/auth.schema.ts';
import { notificationDeliveries } from '../db/system/notification-delivery.schema.ts';
import type { JobsDb } from '../jobs/types.ts';
import { redactNotificationError } from './format.ts';
import { planNotificationRetry } from './retry.ts';
import { sendBarkNotification, type BarkAdapterDeps } from './adapters/bark.ts';
import { sendNotificationEmail, type EmailAdapterDeps } from './adapters/email.ts';
import type { AdapterResult } from './adapters/types.ts';

/**
 * One notification delivery attempt. Claim: `select ... where
 * status='queued' and next_attempt_at <= now() order by created_at for
 * update skip locked` — the webhook segment's discipline, so two drains (web
 * tick + a manual run) never send the same notification twice. The send runs
 * INSIDE the transaction with the row lock held; a crash rolls the status
 * back to `queued` and the next tick retries the same row id (at-least-once,
 * absorbed by the producer's unique key and readable in the log).
 * Outcomes: adapter ok → `sent` (sent_at set, attempts+1); permanent →
 * `failed` (terminal); retryable with budget left → `queued` (1m/5m/15m);
 * budget spent → `failed`. The drain counts these four per tick and any
 * `failed` keeps the tick heartbeat quiet (a dropped notification is not a
 * healthy tick), exactly like the webhook segment. Node-strip-loadable.
 */
export type NotificationDeliveryOutcome = 'sent' | 'failed' | 'retried' | 'skipped';

export interface NotificationDeliveryDeps {
	now: () => Date;
	log: (line: string) => void;
	getEnv?: (name: string) => string | undefined;
	fetch?: typeof fetch;
	/** Test seams (default: the real adapters). */
	sendEmail?: (
		ownerEmail: string | null,
		payload: unknown,
		deps?: EmailAdapterDeps
	) => Promise<AdapterResult>;
	sendBark?: (payload: unknown, deps?: BarkAdapterDeps) => Promise<AdapterResult>;
}

/** The transaction handle's exact type, derived from the drain's db contract. */
type NotificationTx = Parameters<Parameters<JobsDb['transaction']>[0]>[0];
/** Read-only surface the owner lookup needs (a savepoint handle satisfies it). */
type OwnerQueryable = Pick<NotificationTx, 'select'>;

/** Owner inbox for admin notifications; null when no owner row is present. */
async function ownerEmail(db: OwnerQueryable): Promise<string | null> {
	const rows = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.role, 'owner'))
		.limit(1);
	const email = rows[0]?.email?.trim();
	return email ? email : null;
}

/**
 * Resolve the owner address INSIDE A SAVEPOINT. In PostgreSQL any failed
 * statement aborts the whole transaction, so catching a `user`-table error and
 * then writing the delivery row in the same transaction is impossible (every
 * later statement would fail with 25P02). The savepoint lets the lookup fail
 * without poisoning the row lock, so the failure can be recorded as a
 * retryable attempt instead of starving every queued notification behind a
 * permanently broken `user` read.
 */
async function resolveOwnerWithSavepoint(
	tx: NotificationTx
): Promise<{ ok: true; email: string | null } | { ok: false; error: string }> {
	try {
		const email = await tx.transaction(async (savepoint) =>
			ownerEmail(savepoint as unknown as OwnerQueryable)
		);
		return { ok: true, email };
	} catch (error) {
		return { ok: false, error: redactNotificationError(error) };
	}
}

/** Claim + send + finalize ONE due notification; null when nothing is due. */
export async function deliverNotification(
	db: JobsDb,
	deps: NotificationDeliveryDeps
): Promise<NotificationDeliveryOutcome | null> {
	const now = deps.now();
	return db.transaction(async (tx): Promise<NotificationDeliveryOutcome | null> => {
		const [row] = await tx
			.select({
				id: notificationDeliveries.id,
				eventType: notificationDeliveries.eventType,
				eventKey: notificationDeliveries.eventKey,
				channel: notificationDeliveries.channel,
				attempts: notificationDeliveries.attempts,
				payload: notificationDeliveries.payload
			})
			.from(notificationDeliveries)
			.where(
				and(
					eq(notificationDeliveries.status, 'queued'),
					lte(notificationDeliveries.nextAttemptAt, now)
				)
			)
			.orderBy(asc(notificationDeliveries.createdAt))
			.limit(1)
			.for('update', { skipLocked: true });
		if (!row) return null;

		let result: AdapterResult;
		try {
			if (row.channel === 'email') {
				const lookup = await resolveOwnerWithSavepoint(tx);
				if (!lookup.ok) {
					// The lookup failed INSIDE a savepoint: the claim transaction is
					// still usable, so record a retryable attempt instead of letting
					// the error abort the row lock.
					result = {
						ok: false,
						permanent: false,
						error: `owner lookup failed: ${lookup.error}`,
						responseCode: null
					};
					return await finalize(tx, row, result, deps, now);
				}
				result = await (deps.sendEmail ?? sendNotificationEmail)(lookup.email, row.payload, {
					getEnv: deps.getEnv
				});
			} else if (row.channel === 'bark') {
				result = await (deps.sendBark ?? sendBarkNotification)(row.payload, {
					getEnv: deps.getEnv,
					fetch: deps.fetch
				});
			} else {
				// Unreachable: the channel CHECK allows email|bark only. Keep it
				// loud instead of inventing a status for an impossible row.
				throw new Error(`unknown notification channel "${row.channel}"`);
			}
		} catch (error) {
			// An adapter that throws (rather than returning a failure) is a bug,
			// but a notification must not wedge the segment: treat it as a
			// retryable failure and let the budget run out.
			result = {
				ok: false,
				permanent: false,
				error: redactNotificationError(error),
				responseCode: null
			};
		}
		return finalize(tx, row, result, deps, now);
	});
}

type DeliveryRow = {
	id: string;
	eventType: string;
	eventKey: string;
	channel: string;
	attempts: number;
	payload: Record<string, unknown> | null;
};

/** Persist one attempt: `sent`, back to `queued` with a delay, or terminal. */
async function finalize(
	tx: NotificationTx,
	row: DeliveryRow,
	result: AdapterResult,
	deps: NotificationDeliveryDeps,
	startedAt: Date
): Promise<NotificationDeliveryOutcome> {
	// Terminal stamps the attempt-CLOSE time, not the claim time (a slow SMTP
	// handshake must not read as ~0 latency).
	const finishedAt = deps.now();
	const attemptsMade = row.attempts + 1;
	const label = `${row.channel} ${row.eventType} ${row.eventKey}`;
	if (result.ok) {
		await tx
			.update(notificationDeliveries)
			.set({
				status: 'sent',
				attempts: attemptsMade,
				nextAttemptAt: finishedAt,
				responseCode: result.responseCode,
				error: null,
				sentAt: finishedAt
			})
			.where(eq(notificationDeliveries.id, row.id));
		deps.log(`[notify] ${label}: sent in ${finishedAt.getTime() - startedAt.getTime()}ms`);
		return 'sent';
	}
	const plan = planNotificationRetry(attemptsMade);
	if (plan.retry && !result.permanent) {
		await tx
			.update(notificationDeliveries)
			.set({
				status: 'queued',
				attempts: attemptsMade,
				nextAttemptAt: new Date(finishedAt.getTime() + plan.delayMs),
				responseCode: result.responseCode,
				error: redactNotificationError(result.error),
				sentAt: null
			})
			.where(eq(notificationDeliveries.id, row.id));
		deps.log(
			`[notify] ${label}: attempt ${attemptsMade} failed (${result.error}); ` +
				`retry in ${Math.round(plan.delayMs / 1000)}s`
		);
		return 'retried';
	}
	await tx
		.update(notificationDeliveries)
		.set({
			status: 'failed',
			attempts: attemptsMade,
			nextAttemptAt: finishedAt,
			responseCode: result.responseCode,
			error: redactNotificationError(result.error),
			sentAt: null
		})
		.where(eq(notificationDeliveries.id, row.id));
	deps.log(
		`[notify] ${label}: terminal failure after ${attemptsMade} attempt(s) - ${result.error}`
	);
	return 'failed';
}
