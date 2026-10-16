import { activities } from './db/system/activity.schema.ts';
import type { ActivityRefType } from './db/system/activity.schema.ts';
import { enqueueWebhookDeliveries } from './webhooks/outbox.ts';

/**
 * Admin action audit writer (platform §D.2 / ledger §26): one row per admin
 * mutation, written by the service that performs it - so an action can never
 * be authorized without its audit entry on the same call path (and, for
 * db-only flows, inside the same transaction). `refType`/`refId` follow the
 * schema's paired CHECK: supply both or neither. Job names are not uuids, so
 * job-family events carry the name in `payload` instead of the ref arc.
 *
 * The recorded event also fans out to subscribed webhook endpoints through
 * the delivery outbox (SY S1): one `queued` row per endpoint, on the same
 * call path, riding the caller's transaction when one is in scope. Failures
 * propagate - outbound deliveries are never silently dropped.
 */
type AuditExecutor = Pick<typeof import('$lib/server/db').db, 'insert' | 'execute'>;

export interface ActivityInput {
	/** Dotted, lowercase event name (schema CHECK; roster = ledger §26). */
	event: string;
	actorId: string | null;
	refType?: ActivityRefType;
	refId?: string;
	payload?: Record<string, unknown>;
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
	await enqueueWebhookDeliveries(executor, { event: input.event, payload: input.payload });
}
