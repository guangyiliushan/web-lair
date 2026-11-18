import { sql } from 'drizzle-orm';
import { pgErrorCode } from '../db/pg-error.ts';
import { webhookDeliveries } from '../db/system/webhook-delivery.schema.ts';
import { webhooks } from '../db/system/webhook.schema.ts';

/**
 * Webhook delivery outbox: turns an audited event into one `queued` delivery
 * row per subscribed endpoint; the job drain's third segment (`jobs/drain.ts`)
 * claims the rows, signs them with Standard Webhooks headers and POSTs them.
 * Payload: the spec's RECOMMENDED `{ type, timestamp, data }` (field names
 * from the spec example verbatim; the spec does not dictate a structure) — a
 * deliberate subset of CNCF CloudEvents core attributes; a full-envelope mode
 * is the registered additive interop path.
 * Enqueue is ONE `insert ... select`: endpoint matching and row creation share
 * one snapshot, so a concurrent endpoint delete can never leave a half-matched
 * fan-out; matching is `events @> array[event]` (GIN `array_ops`-indexable if
 * this table grows).
 * Contract: rides the caller's transaction when in scope and any failure
 * propagates (fail loud; a delivery is never silently dropped). The statement
 * runs in `executor.transaction()` (a SAVEPOINT under a caller transaction):
 * a concurrent endpoint delete raises FK 23503, so ONLY that code rolls the
 * savepoint back (a vanished endpoint has no delivery obligation); every
 * other error stays loud.
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
