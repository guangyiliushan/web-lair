import { activities } from './db/system/activity.schema.ts';
import type { ActivityRefType } from './db/system/activity.schema.ts';
import { enqueueWebhookDeliveries } from './webhooks/outbox.ts';

/**
 * Admin action audit writer: one row per admin mutation, written by the
 * service that performs it, so an action can never be authorized without its
 * audit entry on the same call path — for db-only flows, inside the same
 * transaction. `refType`/`refId` follow the schema's paired CHECK: supply
 * both or neither; job-family events carry the non-uuid job name in
 * `payload` instead of the ref arc.
 * Recorded events fan out to subscribed endpoints through the delivery
 * outbox: one `queued` row per endpoint on the same call path, riding the
 * caller's transaction. Failures propagate — outbound deliveries are never
 * silently dropped.
 * `AuditExecutor` types `transaction` as "runs a callback with something
 * that can execute", not the app db's full schema-parameterised signature:
 * the drain harness builds its own schema-less drizzle client and both must
 * satisfy this.
 */
type AuditTx = Pick<typeof import('$lib/server/db').db, 'execute'>;
type AuditExecutor = AuditTx & {
	insert: Pick<typeof import('$lib/server/db').db, 'insert'>['insert'];
	transaction: <T>(callback: (savepoint: AuditTx) => Promise<T>) => Promise<T>;
};

export interface ActivityInput {
	/** Dotted, lowercase event name (schema CHECK). */
	event: string;
	actorId: string | null;
	refType?: ActivityRefType;
	refId?: string;
	payload?: Record<string, unknown>;
	/**
	 * Set `false` to keep the row local. Secret event
	 * metadata must not leave the box: a key-set/rotate/clear row or a failure
	 * burst would otherwise fan out to every subscribed webhook.
	 */
	deliver?: boolean;
}

export async function recordActivity(executor: AuditExecutor, input: ActivityInput): Promise<void> {
	await executor.insert(activities).values({
		event: input.event,
		actorId: input.actorId,
		refType: input.refType ?? null,
		refId: input.refId ?? null,
		payload: input.payload ?? null
	});
	// Deliveries ride the same call path: the audit row and its outbound
	// fan-out share one fate (the caller's transaction when one is in scope).
	if (input.deliver !== false) {
		await enqueueWebhookDeliveries(executor, { event: input.event, payload: input.payload });
	}
}

/**
 * System-initiated endpoint disable (410 Gone from the receiver). Kept here,
 * not inline in `jobs/drain.ts`: the webhook event-roster source scan treats
 * every `event:` literal under `src/lib/server/jobs` as a subscription
 * producer, and this is an audit-only event.
 */
export async function recordWebhookAutoDisable(
	executor: AuditExecutor,
	input: { webhookId: string; name: string }
): Promise<void> {
	await recordActivity(executor, {
		event: 'webhook.auto_disable',
		actorId: null,
		payload: { ...input, status: 410 },
		deliver: false
	});
}
