import { createHmac } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { emailSuppressions } from '$lib/server/db/system';
import { decodeHmacKey, hashEmail } from './email-hash';
import { normalizeEmail } from './email-normalize';

/**
 * Email suppression (CAN-SPAM / RFC 8058 / ICO): opt-outs outlive their subscription rows.
 * The table stores only a keyed hash; a missing or invalid key fails closed, never an unkeyed hash
 * - that would open a second hash domain where old opt-outs turn invisible.
 * Key versions derive from that one master (rotation steps: `deploy/RUNBOOK.md` → "Email retention
 * and suppression"); a rotation starts a version for new writes while reads cover 1..active.
 */
export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained';

export type SuppressionExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const REASON_RANK: Record<SuppressionReason, number> = {
	unsubscribed: 1,
	bounced: 2,
	complained: 3
};

export class SuppressionKeyMissingError extends Error {
	constructor() {
		super(
			'SUPPRESSION_HMAC_KEY is missing or not 32 base64-encoded bytes; suppression operations are disabled'
		);
		this.name = 'SuppressionKeyMissingError';
	}
}

export class SuppressionKeyVersionError extends Error {
	constructor(raw: string) {
		super(
			`SUPPRESSION_HMAC_KEY_VERSION="${raw}" is not a positive integer; suppression operations are disabled`
		);
		this.name = 'SuppressionKeyVersionError';
	}
}

/** Active key version; 1 when unset, never a silent fallback for garbage. */
export function activeSuppressionKeyVersion(): number {
	const raw = (env.SUPPRESSION_HMAC_KEY_VERSION ?? '').trim();
	if (!raw) return 1;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) throw new SuppressionKeyVersionError(raw);
	return parsed;
}

/** Fail fast on boot (production) instead of on the first opt-out. */
export function assertSuppressionKey(): void {
	if (!decodeHmacKey(env.SUPPRESSION_HMAC_KEY)) throw new SuppressionKeyMissingError();
	activeSuppressionKeyVersion();
}

/**
 * Suppression hashing must never fail a compliance write. Form and webhook
 * intake validate strictly before calling this; legacy rows can still hold an
 * address the practical regex rejects (RFC 5321 permits `user@localhost`,
 * quoted local parts, etc.). Fall back to trim+lowercase so an opt-out for
 * such a row still produces a stable hash instead of a 500/503 loop.
 */
function canonicalSuppressionAddress(email: string): string {
	return normalizeEmail(email) ?? email.trim().toLowerCase();
}

function masterKey(): Buffer {
	const key = decodeHmacKey(env.SUPPRESSION_HMAC_KEY);
	if (!key) throw new SuppressionKeyMissingError();
	return key;
}

/** Per-version key. Version 1 is the master itself (pre-F-14 hashes). */
function suppressionKey(version: number, master: Buffer): Buffer {
	if (version === 1) return master;
	return createHmac('sha256', master).update(`wl:suppression:key:v${version}`).digest();
}

function hashAt(email: string, version: number, master: Buffer): string {
	return hashEmail(canonicalSuppressionAddress(email), suppressionKey(version, master));
}

/** Every hash the address can carry under the configured versions. */
export function suppressionHashes(email: string): { version: number; hash: string }[] {
	const master = masterKey();
	const active = activeSuppressionKeyVersion();
	const out: { version: number; hash: string }[] = [];
	for (let version = 1; version <= active; version += 1) {
		out.push({ version, hash: hashAt(email, version, master) });
	}
	return out;
}

/** Hash under the active version (what new rows are written with). */
export function suppressionHash(email: string): string {
	return hashAt(email, activeSuppressionKeyVersion(), masterKey());
}

function strongestReason(reasons: string[]): SuppressionReason | null {
	let best: SuppressionReason | null = null;
	for (const reason of reasons) {
		if (!Object.hasOwn(REASON_RANK, reason)) continue;
		const candidate = reason as SuppressionReason;
		if (best === null || REASON_RANK[candidate] > REASON_RANK[best]) best = candidate;
	}
	return best;
}

export async function suppressionReason(email: string): Promise<SuppressionReason | null> {
	const rows = await db
		.select({ reason: emailSuppressions.reason })
		.from(emailSuppressions)
		.where(
			inArray(
				emailSuppressions.emailHash,
				suppressionHashes(email).map((entry) => entry.hash)
			)
		);
	return strongestReason(rows.map((row) => row.reason));
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
 *
 * A row still on an older key version is folded into the active version in the
 * same call (the plaintext is only available here), so the table converges
 * without a batch rehash.
 */
export async function suppress(
	email: string,
	reason: SuppressionReason,
	source: string,
	executor: SuppressionExecutor = db
): Promise<void> {
	const active = activeSuppressionKeyVersion();
	const hashes = suppressionHashes(email);
	const activeHash = hashes[hashes.length - 1].hash;
	const staleHashes = hashes.slice(0, -1).map((entry) => entry.hash);

	let mergedReason: SuppressionReason = reason;
	let mergedSource = source;
	if (staleHashes.length > 0) {
		const staleRows = await executor
			.select({ reason: emailSuppressions.reason, source: emailSuppressions.source })
			.from(emailSuppressions)
			.where(inArray(emailSuppressions.emailHash, staleHashes));
		const strongest = strongestReason([...staleRows.map((row) => row.reason), reason]);
		if (strongest !== null && REASON_RANK[strongest] > REASON_RANK[reason]) {
			mergedReason = strongest;
			const winner = staleRows.find((row) => row.reason === strongest);
			if (winner) mergedSource = winner.source;
		}
	}

	await executor
		.insert(emailSuppressions)
		.values({
			emailHash: activeHash,
			reason: mergedReason,
			source: mergedSource,
			keyVersion: active
		})
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

	if (staleHashes.length > 0) {
		await executor
			.delete(emailSuppressions)
			.where(inArray(emailSuppressions.emailHash, staleHashes));
	}
}

/**
 * Re-subscription after a confirmation lifts only the soft opt-out. A
 * hard-bounce / complaint record is never lifted by the user-facing flow.
 */
export async function liftUnsubscribedSuppression(
	email: string,
	executor: SuppressionExecutor = db
): Promise<void> {
	await executor.delete(emailSuppressions).where(
		and(
			inArray(
				emailSuppressions.emailHash,
				suppressionHashes(email).map((entry) => entry.hash)
			),
			eq(emailSuppressions.reason, 'unsubscribed')
		)
	);
}
