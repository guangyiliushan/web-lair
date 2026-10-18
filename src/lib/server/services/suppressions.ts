import { and, eq, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { emailSuppressions } from '$lib/server/db/system';
import { decodeHmacKey, hashEmail } from './email-hash';

/**
 * Email suppression (E2-1, CAN-SPAM / RFC 8058 / ICO): a "do not contact"
 * record must survive the subscription row it came from.
 *
 * The table stores only a keyed hash. `SUPPRESSION_HMAC_KEY` (32B base64) is
 * independent of the auth secret and must be set before the first write and
 * kept in backups: rotating it orphans every existing hash.
 *
 * If the key is missing or invalid we fail closed. Writing an unkeyed SHA-256
 * would create a second hash domain: once the key is added, those opt-outs
 * become invisible and a hard-bounced address becomes mailable again.
 */
export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained';

export type SuppressionExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class SuppressionKeyMissingError extends Error {
	constructor() {
		super(
			'SUPPRESSION_HMAC_KEY is missing or not 32 base64-encoded bytes; suppression operations are disabled'
		);
		this.name = 'SuppressionKeyMissingError';
	}
}

/** Fail fast on boot (production) instead of on the first opt-out. */
export function assertSuppressionKey(): void {
	if (!decodeHmacKey(env.SUPPRESSION_HMAC_KEY)) throw new SuppressionKeyMissingError();
}

export function suppressionHash(email: string): string {
	const key = decodeHmacKey(env.SUPPRESSION_HMAC_KEY);
	if (!key) throw new SuppressionKeyMissingError();
	return hashEmail(email, key);
}

export async function suppressionReason(email: string): Promise<SuppressionReason | null> {
	const [row] = await db
		.select({ reason: emailSuppressions.reason })
		.from(emailSuppressions)
		.where(eq(emailSuppressions.emailHash, suppressionHash(email)))
		.limit(1);
	return row ? (row.reason as SuppressionReason) : null;
}

const REASON_RANK_SQL = sql`case
	when ${emailSuppressions.reason} = 'complained' then 'complained'
	when excluded.reason = 'complained' then 'complained'
	when ${emailSuppressions.reason} = 'bounced' then 'bounced'
	else excluded.reason
end`;

/**
 * Idempotent and monotonic: a hard bounce or a complaint must upgrade a soft
 * `unsubscribed` row, never the other way round. Dropping a complaint because
 * an unsubscribe happened first would make the address mailable again after a
 * re-subscription, and the provider will not report it twice.
 */
export async function suppress(
	email: string,
	reason: SuppressionReason,
	source: string,
	executor: SuppressionExecutor = db
): Promise<void> {
	await executor
		.insert(emailSuppressions)
		.values({ emailHash: suppressionHash(email), reason, source })
		.onConflictDoUpdate({
			target: emailSuppressions.emailHash,
			set: {
				reason: REASON_RANK_SQL,
				source: sql`case
					when excluded.reason = 'complained' and ${emailSuppressions.reason} <> 'complained' then excluded.source
					when excluded.reason = 'bounced' and ${emailSuppressions.reason} = 'unsubscribed' then excluded.source
					else ${emailSuppressions.source}
				end`
			}
		});
}

/**
 * Re-subscription after a confirmation lifts only the soft opt-out. A
 * hard-bounce / complaint record is never lifted by the user-facing flow.
 */
export async function liftUnsubscribedSuppression(
	email: string,
	executor: SuppressionExecutor = db
): Promise<void> {
	await executor
		.delete(emailSuppressions)
		.where(
			and(
				eq(emailSuppressions.emailHash, suppressionHash(email)),
				eq(emailSuppressions.reason, 'unsubscribed')
			)
		);
}
