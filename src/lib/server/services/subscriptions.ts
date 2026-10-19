import { and, eq, gte, isNull, ne, or } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { subscriptions } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { keyedHasher } from './email-hash';
import {
	hashSubscriptionToken,
	isSubscriptionToken,
	newSubscriptionToken
} from './subscription-token';
import { liftUnsubscribedSuppression, suppress, suppressionReason } from './suppressions';

export { isSubscriptionToken, newSubscriptionToken } from './subscription-token';
export { normalizeEmail } from './email-normalize';

/**
 * Double opt-in subscriptions (deploy batch D-2; schema from ledger §26).
 *
 * State machine: pending → subscribed → unsubscribed. Resubmitting the form
 * for an already-subscribed address is a **no-op** — otherwise anyone could
 * knock a confirmed reader back to pending by typing their address. The token
 * is the only credential and stays valid after confirmation so the
 * unsubscribe link keeps working (it is not a single-use nonce).
 *
 * No IP/UA is stored (schema and privacy line). Pending rows whose link has
 * been dead for 30 days are removed by the `subscriptions.sweep` job (E1-2).
 */

export type SubscriptionLang = 'en' | 'zh-cn' | 'ja';
export type SubscriptionStatus = 'pending' | 'subscribed' | 'unsubscribed';

/**
 * Version of the consent text shown on the public form (E2-2). Bump when the
 * wording or the purposes change; rows keep the version they were collected
 * under so an export can answer "which text did this reader agree to".
 */
export const CONSENT_VERSION = '2026-10-v1';

/** A still-pending address is not re-mailed (nor its live link voided) inside this window. */
const RESEND_COOLDOWN_MS = 15 * 60 * 1000;
/**
 * Confirmation-link lifetime (OWASP: single-purpose tokens must expire; NIST
 * SP 800-63B-4 §4.2: emailed recovery codes SHALL expire within 24 hours).
 * Default 24h; `SUBSCRIBE_TOKEN_TTL_DAYS` may raise it to at most 72h and any
 * larger value is clamped with a warning. `updated_at` is the current token's
 * issue time because every rotation writes the row; a resend therefore starts
 * a fresh window. Unsubscribe links never expire (opt-out must always work).
 */
const DEFAULT_TOKEN_TTL_DAYS = 1;
const MAX_TOKEN_TTL_DAYS = 3;
const warnedTtlClamps = new Set<string>();

export function subscriptionTokenTtlMs(rawDays: string | undefined): number {
	const raw = rawDays?.trim() ?? '';
	const parsed = Number(raw);
	const days = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_TTL_DAYS;
	if (days > MAX_TOKEN_TTL_DAYS) {
		if (!warnedTtlClamps.has(raw)) {
			warnedTtlClamps.add(raw);
			console.warn(
				`[subscribe] SUBSCRIBE_TOKEN_TTL_DAYS=${raw} exceeds the ${MAX_TOKEN_TTL_DAYS}-day (72h) ceiling; clamped`
			);
		}
		return MAX_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
	}
	return days * 24 * 60 * 60 * 1000;
}

let addressHasher: { raw: string | undefined; hash: ((email: string) => string) | null } | null =
	null;

/**
 * Keyed bucket for the per-address daily cap. Missing/invalid key degrades to
 * IP-only limiting with one loud log (the site must stay usable), never to a
 * shared or plaintext bucket.
 */
export function subscribeAddressKey(email: string): string | null {
	const raw = env.SUBSCRIBE_HMAC_KEY;
	if (!addressHasher || addressHasher.raw !== raw) {
		addressHasher = { raw, hash: keyedHasher('SUBSCRIBE_HMAC_KEY', raw) };
	}
	return addressHasher.hash?.(email) ?? null;
}

export function isSubscriptionLang(value: string): value is SubscriptionLang {
	return value === 'en' || value === 'zh-cn' || value === 'ja';
}

export interface PreviousSubscription {
	status: SubscriptionStatus;
	token: string;
	tokenHash: string | null;
	lang: SubscriptionLang;
	source: string | null;
	consentVersion: string | null;
	verifiedAt: Date | null;
	unsubscribedAt: Date | null;
	updatedAt: Date;
}

export type RequestSubscriptionResult =
	| { kind: 'pending'; token: string; send: boolean; previous?: PreviousSubscription }
	| { kind: 'already-subscribed' }
	| { kind: 'suppressed' };

export async function requestSubscription(input: {
	email: string;
	lang: SubscriptionLang;
	source: string;
}): Promise<RequestSubscriptionResult> {
	// Hard bounces and complaints block every send, including a fresh form
	// submission: the address is not deliverable or the recipient reported it.
	// A soft `unsubscribed` record does NOT block a self-submitted form (D-1);
	// the confirmation step is the new consent, and a successful confirm lifts
	// the soft suppression (bulk senders must still filter the table).
	const suppression = await suppressionReason(input.email);
	if (suppression === 'bounced' || suppression === 'complained') return { kind: 'suppressed' };

	const [existing] = await db
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.email, input.email))
		.limit(1);

	if (existing?.status === 'subscribed') return { kind: 'already-subscribed' };

	// Cooldown: a pending address keeps the token already mailed to it and gets
	// no second message — a form spammer cannot flood an inbox or void the link
	// the recipient already holds.
	const updatedAt = existing?.updatedAt instanceof Date ? existing.updatedAt.getTime() : 0;
	if (existing?.status === 'pending' && Date.now() - updatedAt < RESEND_COOLDOWN_MS) {
		return { kind: 'pending', token: existing.token, send: false };
	}

	const token = newSubscriptionToken();
	if (existing) {
		// Keep enough state to undo a resubscribe whose mail never left: deleting
		// a row that used to be `unsubscribed` would erase the opt-out record.
		const previous: PreviousSubscription = {
			status: existing.status as SubscriptionStatus,
			token: existing.token,
			tokenHash: existing.tokenHash,
			lang: existing.lang as SubscriptionLang,
			source: existing.source,
			consentVersion: existing.consentVersion,
			verifiedAt: existing.verifiedAt,
			unsubscribedAt: existing.unsubscribedAt,
			updatedAt: existing.updatedAt
		};
		// Compare-and-swap on the token we read: a concurrent confirm wins, and a
		// parallel resubmit loses instead of voiding the link it just mailed.
		const updated = await db
			.update(subscriptions)
			.set({
				status: 'pending',
				token,
				tokenHash: hashSubscriptionToken(token),
				lang: input.lang,
				source: input.source,
				consentVersion: CONSENT_VERSION,
				verifiedAt: null
			})
			.where(
				and(
					eq(subscriptions.id, existing.id),
					ne(subscriptions.status, 'subscribed'),
					or(
						eq(subscriptions.tokenHash, hashSubscriptionToken(existing.token)),
						eq(subscriptions.token, existing.token)
					)
				)
			)
			.returning({ id: subscriptions.id });
		if (updated.length === 0) {
			const [again] = await db
				.select()
				.from(subscriptions)
				.where(eq(subscriptions.id, existing.id))
				.limit(1);
			if (again?.status === 'subscribed') return { kind: 'already-subscribed' };
			// Someone else is holding (and mailed) the current token.
			if (again) return { kind: 'pending', token: again.token, send: false };
			// The row vanished (pending unsubscribe): fall through and insert.
		}
		if (updated.length > 0) return { kind: 'pending', token, send: true, previous };
	}

	try {
		await db.insert(subscriptions).values({
			email: input.email,
			lang: input.lang,
			source: input.source,
			consentVersion: CONSENT_VERSION,
			token,
			tokenHash: hashSubscriptionToken(token)
		});
	} catch (error) {
		// Concurrent first submission: the unique index wins, re-read and treat
		// it as a pending row (the stored token is the one already mailed out).
		if (pgErrorCode(error) === '23505') {
			const [again] = await db
				.select()
				.from(subscriptions)
				.where(eq(subscriptions.email, input.email))
				.limit(1);
			if (!again) throw error;
			if (again.status === 'subscribed') return { kind: 'already-subscribed' };
			// The concurrent winner owns the mail for this address.
			return { kind: 'pending', token: again.token, send: false };
		}
		throw error;
	}

	return { kind: 'pending', token, send: true };
}

export interface SubscriptionLookup {
	id: string;
	status: SubscriptionStatus;
	email: string;
	/** Pending row whose confirmation window has passed. Unsubscribe ignores it. */
	expired: boolean;
}

export async function subscriptionByToken(token: string): Promise<SubscriptionLookup | null> {
	if (!isSubscriptionToken(token)) {
		// A bare page hit (no token) is crawler traffic, not an incident.
		if (token !== '') console.warn('[subscribe] token rejected: malformed');
		return null;
	}
	const tokenHash = hashSubscriptionToken(token);
	// Hash-first (E2-3). Legacy rows created before the column existed are still
	// reachable through the plaintext column; the first successful lookup
	// backfills the hash so the next read never touches plaintext.
	let [row] = await db
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.tokenHash, tokenHash))
		.limit(1);
	if (!row) {
		[row] = await db.select().from(subscriptions).where(eq(subscriptions.token, token)).limit(1);
		if (row && row.tokenHash === null) {
			try {
				await db
					.update(subscriptions)
					.set({ tokenHash, updatedAt: row.updatedAt })
					.where(
						and(
							eq(subscriptions.id, row.id),
							isNull(subscriptions.tokenHash),
							eq(subscriptions.token, token)
						)
					);
			} catch (error) {
				console.warn('[subscribe] token hash backfill failed', error);
			}
		}
	}
	if (!row) {
		console.warn('[subscribe] token rejected: unknown');
		return null;
	}
	const cutoff = new Date(Date.now() - subscriptionTokenTtlMs(env.SUBSCRIBE_TOKEN_TTL_DAYS));
	const expired = row.status === 'pending' && row.updatedAt < cutoff;
	return { id: row.id, status: row.status as SubscriptionStatus, email: row.email, expired };
}

export type ConfirmResult =
	'subscribed' | 'already-subscribed' | 'unsubscribed' | 'expired' | 'invalid';

async function statusOfToken(token: string): Promise<ConfirmResult> {
	const again = await subscriptionByToken(token);
	if (!again) return 'invalid';
	if (again.status === 'subscribed') return 'already-subscribed';
	if (again.status === 'unsubscribed') return 'unsubscribed';
	if (again.status === 'pending' && again.expired) return 'expired';
	return 'invalid';
}

export async function confirmSubscription(token: string): Promise<ConfirmResult> {
	// Conditional write: a concurrent unsubscribe (delete or status change) must
	// win over this confirm instead of being overwritten by a blind UPDATE. The
	// timestamp predicate implements the TTL atomically (no read-then-write gap).
	// The lift runs in the same transaction: an unsubscribe that commits after
	// this block re-adds the suppression, and one that committed first makes the
	// status predicate miss (so we never delete a fresh opt-out).
	// Deliberately no suppression check here: the form already blocks hard
	// bounces/complaints, and a late pending link may still confirm. Bulk senders
	// must filter email_suppressions; see F-17 in deploy-followups.
	const cutoff = new Date(Date.now() - subscriptionTokenTtlMs(env.SUBSCRIBE_TOKEN_TTL_DAYS));
	const tokenHash = hashSubscriptionToken(token);
	const confirmed = await db.transaction(async (tx) => {
		const updated = await tx
			.update(subscriptions)
			.set({ status: 'subscribed', verifiedAt: new Date() })
			.where(
				and(
					or(eq(subscriptions.tokenHash, tokenHash), eq(subscriptions.token, token)),
					eq(subscriptions.status, 'pending'),
					gte(subscriptions.updatedAt, cutoff)
				)
			)
			.returning({ id: subscriptions.id, email: subscriptions.email });
		const email = updated[0]?.email;
		if (updated.length === 0) return null;
		// A re-subscribed reader is no longer suppressing bulk mail. Only the soft
		// record is lifted; a hard bounce/complaint must survive.
		if (email) await liftUnsubscribedSuppression(email, tx);
		return 'subscribed' as const;
	});
	if (confirmed) return confirmed;
	return statusOfToken(token);
}

export type UnsubscribeResult = 'unsubscribed' | 'already-unsubscribed' | 'invalid';

export type UnsubscribeSource = 'unsubscribe-page' | 'one-click';

export async function unsubscribe(
	token: string,
	source: UnsubscribeSource = 'unsubscribe-page'
): Promise<UnsubscribeResult> {
	// Pending rows cannot be marked unsubscribed (the CHECK requires
	// verified_at on non-pending rows), so an opt-out from a never-confirmed
	// address deletes the row. The delete/update and the suppression write are
	// one transaction: an opt-out that is not remembered is a compliance bug.
	// The credential predicate accepts either the hash or the retained plaintext
	// column (dual-read window), and stays status-guarded so a concurrent
	// confirm wins.
	const tokenHash = hashSubscriptionToken(token);
	const credential = or(eq(subscriptions.tokenHash, tokenHash), eq(subscriptions.token, token));

	const outcome = await db.transaction(async (tx) => {
		const deleted = await tx
			.delete(subscriptions)
			.where(and(credential, eq(subscriptions.status, 'pending')))
			.returning({ email: subscriptions.email });
		if (deleted.length > 0) {
			await suppress(deleted[0].email, 'unsubscribed', source, tx);
			return 'unsubscribed' as const;
		}

		const updated = await tx
			.update(subscriptions)
			.set({ status: 'unsubscribed', unsubscribedAt: new Date() })
			.where(and(credential, eq(subscriptions.status, 'subscribed')))
			.returning({ email: subscriptions.email });
		if (updated.length > 0) {
			await suppress(updated[0].email, 'unsubscribed', source, tx);
			return 'unsubscribed' as const;
		}

		const [again] = await tx
			.select({ status: subscriptions.status, email: subscriptions.email })
			.from(subscriptions)
			.where(credential)
			.limit(1);
		if (again?.status === 'unsubscribed') {
			// Repair legacy rows: the terminal state exists but the suppression
			// record may predate this batch (idempotent insert).
			await suppress(again.email, 'unsubscribed', source, tx);
			return 'already-unsubscribed' as const;
		}
		return null;
	});

	return outcome ?? 'invalid';
}

/** Drops a pending row whose confirmation mail could not be delivered. */
export async function discardPendingToken(token: string): Promise<void> {
	await db
		.delete(subscriptions)
		.where(
			and(
				eq(subscriptions.tokenHash, hashSubscriptionToken(token)),
				eq(subscriptions.status, 'pending')
			)
		);
}

/** Restores the row a failed send had rotated to pending (token-guarded). */
export async function restoreSubscription(
	token: string,
	previous: PreviousSubscription
): Promise<void> {
	await db
		.update(subscriptions)
		.set({
			status: previous.status,
			token: previous.token,
			tokenHash: previous.tokenHash ?? hashSubscriptionToken(previous.token),
			lang: previous.lang,
			source: previous.source,
			consentVersion: previous.consentVersion,
			verifiedAt: previous.verifiedAt,
			unsubscribedAt: previous.unsubscribedAt,
			updatedAt: previous.updatedAt
		})
		.where(
			and(
				eq(subscriptions.tokenHash, hashSubscriptionToken(token)),
				eq(subscriptions.status, 'pending')
			)
		);
}
