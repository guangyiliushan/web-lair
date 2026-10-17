import { sql } from 'drizzle-orm';
import { pgErrorCode } from '../db/pg-error.ts';
import { webhookDeliveries } from '../db/system/webhook-delivery.schema.ts';
import { webhooks } from '../db/system/webhook.schema.ts';

/**
 * Webhook delivery outbox (SY S1; ledger §26 / platform plan §D.3): turns an
 * audited event into one `queued` delivery row per subscribed endpoint. The
 * job drain's third segment (`jobs/drain.ts`) claims the rows, signs them
 * with Standard Webhooks headers and POSTs them.
 *
 * Payload body: the Standard Webhooks RECOMMENDED shape - the spec explicitly
 * `does not dictate` a payload structure, it only offers recommendations - so
 * this is `{ type, timestamp, data }` (the spec example's field names
 * verbatim). It is deliberately a subset of the CNCF CloudEvents core
 * attributes (type/time/data): a future full-envelope mode is additive
 * (specversion/id/source), registered as the interop upgrade path.
 *
 * Enqueue is a SINGLE statement (`insert ... select`): endpoint matching and
 * row creation share one snapshot, so a concurrent endpoint delete can never
 * leave a half-matched fan-out. Matching is `events @> array[event]` - the
 * exact operator form the GIN `array_ops` opclass can index if this table
 * ever grows (threshold-based defer, registered).
 *
 * Contract (S1 grill ruling): same call path as the audit row - it rides the
 * caller's transaction when one is in scope, and any failure propagates
 * (fail loud). A delivery is never silently dropped; the residual gap on
 * plain-`db` call sites (audit row committed, enqueue failing on a DB-level
 * error) is a registered observation item, not a silent path.
 *
 * The statement runs inside `executor.transaction()` (a SAVEPOINT when the
 * caller already holds a transaction): a concurrent endpoint delete makes the
 * FK check raise 23503, which without a savepoint would abort the CALLER's
 * business write. A vanished endpoint has no delivery obligation, so ONLY
 * that code is swallowed by rolling back the savepoint; every other error
 * stays loud (nine-dimension Q4; PG SAVEPOINT semantics and the drizzle
 * nested-transaction/savepoint mapping verified in the grill).
 */
export interface DeliveryPayload {
	type: string;
	timestamp: string;
	data: Record<string, unknown>;
}

/** Pure builder for the delivery body (unit-tested; no db imports leak here). */
export function buildDeliveryPayload(
	event: string,
	data?: Record<string, unknown> | null,
	now: Date = new Date()
): DeliveryPayload {
	return { type: event, timestamp: now.toISOString(), data: data ?? {} };
}

/**
 * Structural executor contract (same seam as `audit.ts`): the savepoint
 * callback only needs to execute SQL, so the transaction signature stays
 * independent of the caller's drizzle schema generic.
 */
type OutboxTx = Pick<typeof import('$lib/server/db').db, 'execute'>;
type OutboxExecutor = OutboxTx & {
	transaction: <T>(callback: (savepoint: OutboxTx) => Promise<T>) => Promise<T>;
};

export interface OutboxInput {
	/** Dotted, lowercase event name (the activities CHECK is the source of truth). */
	event: string;
	payload?: Record<string, unknown> | null;
}

/** Enqueue one `queued` delivery per enabled endpoint subscribed to `event`. */
export async function enqueueWebhookDeliveries(
	executor: OutboxExecutor,
	input: OutboxInput
): Promise<void> {
	const body = JSON.stringify(buildDeliveryPayload(input.event, input.payload));
	try {
		await executor.transaction(async (savepoint) => {
			await savepoint.execute(sql`
		insert into ${webhookDeliveries} (webhook_id, event, payload)
		select ${webhooks.id}, ${input.event}, ${body}::jsonb
		from ${webhooks}
		where ${webhooks.isEnabled} and ${webhooks.events} @> array[${input.event}::text]
	`);
		});
	} catch (error) {
		// 23503 = the endpoint vanished between snapshot and FK check: the
		// savepoint rolled the fan-out back, the caller's audit row and
		// business write survive (contract above).
		if (pgErrorCode(error) === '23503') return;
		throw error;
	}
}
