import { sql } from 'drizzle-orm';
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

type OutboxExecutor = Pick<typeof import('$lib/server/db').db, 'execute'>;

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
	await executor.execute(sql`
		insert into ${webhookDeliveries} (webhook_id, event, payload)
		select ${webhooks.id}, ${input.event}, ${body}::jsonb
		from ${webhooks}
		where ${webhooks.isEnabled} and ${webhooks.events} @> array[${input.event}::text]
	`);
}
