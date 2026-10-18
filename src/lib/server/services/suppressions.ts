import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
 * If the key is missing we fall back to an unkeyed SHA-256 and log loudly:
 * opt-out must keep working, and losing the suppression row is worse than the
 * weaker (still 64-hex) hash. Set the key in production.
 */
export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained';

export type SuppressionExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

let warnedMissingKey = false;

export function suppressionHash(email: string): string {
	const key = decodeHmacKey(env.SUPPRESSION_HMAC_KEY);
	if (!key) {
		if (!warnedMissingKey) {
			warnedMissingKey = true;
			console.error(
				'[suppressions] SUPPRESSION_HMAC_KEY is missing or invalid; falling back to an unkeyed SHA-256 (set the key in production)'
			);
		}
		return createHash('sha256').update(email).digest('hex');
	}
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

/**
 * Idempotent: the first reason wins (`on conflict do nothing`). A bounce that
 * arrives after an unsubscribe must not rewrite the audit record; both block
 * bulk delivery, and the earlier signal is the more meaningful one.
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
		.onConflictDoNothing();
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
