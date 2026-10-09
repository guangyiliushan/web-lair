import { activities } from './db/system/activity.schema.ts';
import type { ActivityRefType } from './db/system/activity.schema.ts';

/**
 * Admin action audit writer (platform §D.2 / ledger §26): one row per admin
 * mutation, written by the service that performs it - so an action can never
 * be authorized without its audit entry on the same call path (and, for
 * db-only flows, inside the same transaction). `refType`/`refId` follow the
 * schema's paired CHECK: supply both or neither. Job names are not uuids, so
 * job-family events carry the name in `payload` instead of the ref arc.
 */
type AuditExecutor = Pick<typeof import('$lib/server/db').db, 'insert'>;

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
}
