import { and, eq, gte, ne } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { subscriptions } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { keyedHasher } from './email-hash';
import { isSubscriptionToken, newSubscriptionToken } from './subscription-token';

export { isSubscriptionToken, newSubscriptionToken } from './subscription-token';

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

const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
	const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_TTL_DAYS;
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

export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	if (email.length === 0 || email.length > EMAIL_MAX) return null;
	if (!EMAIL_RE.test(email)) return null;
	return email;
}

export function isSubscriptionLang(value: string): value is SubscriptionLang {
	return value === 'en' || value === 'zh-cn' || value === 'ja';
}

export interface PreviousSubscription {
	status: SubscriptionStatus;
	token: string;
	lang: SubscriptionLang;
	source: string | null;
	verifiedAt: Date | null;
	unsubscribedAt: Date | null;
}

export type RequestSubscriptionResult =
	| { kind: 'pending'; token: string; send: boolean; previous?: PreviousSubscription }
	| { kind: 'already-subscribed' };

export async function requestSubscription(input: {
	email: string;
	lang: SubscriptionLang;
	source: string;
}): Promise<RequestSubscriptionResult> {
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
			lang: existing.lang as SubscriptionLang,
			source: existing.source,
			verifiedAt: existing.verifiedAt,
			unsubscribedAt: existing.unsubscribedAt
		};
		// Compare-and-swap on the token we read: a concurrent confirm wins, and a
		// parallel resubmit loses instead of voiding the link it just mailed.
		const updated = await db
			.update(subscriptions)
			.set({
				status: 'pending',
				token,
				lang: input.lang,
				source: input.source,
				verifiedAt: null
			})
			.where(
				and(
					eq(subscriptions.id, existing.id),
					ne(subscriptions.status, 'subscribed'),
					eq(subscriptions.token, existing.token)
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
			token
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
	const [row] = await db
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.token, token))
		.limit(1);
	if (!row) {
		console.warn('[subscribe] token rejected: unknown');
		return null;
	}
	const cutoff = new Date(Date.now() - subscriptionTokenTtlMs(env.SUBSCRIBE_TOKEN_TTL_DAYS));
	const expired = row.status === 'pending' && row.updatedAt < cutoff;
	return { status: row.status as SubscriptionStatus, email: row.email, expired };
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
	const cutoff = new Date(Date.now() - subscriptionTokenTtlMs(env.SUBSCRIBE_TOKEN_TTL_DAYS));
	const updated = await db
		.update(subscriptions)
		.set({ status: 'subscribed', verifiedAt: new Date() })
		.where(
			and(
				eq(subscriptions.token, token),
				eq(subscriptions.status, 'pending'),
				gte(subscriptions.updatedAt, cutoff)
			)
		)
		.returning({ id: subscriptions.id });
	if (updated.length === 0) return statusOfToken(token);
	return 'subscribed';
}

export type UnsubscribeResult = 'unsubscribed' | 'already-unsubscribed' | 'invalid';

export async function unsubscribe(token: string): Promise<UnsubscribeResult> {
	// Pending rows cannot be marked unsubscribed (the CHECK requires
	// verified_at on non-pending rows), so an opt-out from a never-confirmed
	// address deletes the row. Both writes are predicate-guarded: a concurrent
	// confirm must never be erased or overwritten.
	const deleted = await db
		.delete(subscriptions)
		.where(and(eq(subscriptions.token, token), eq(subscriptions.status, 'pending')))
		.returning({ id: subscriptions.id });
	if (deleted.length > 0) return 'unsubscribed';

	const updated = await db
		.update(subscriptions)
		.set({ status: 'unsubscribed', unsubscribedAt: new Date() })
		.where(and(eq(subscriptions.token, token), eq(subscriptions.status, 'subscribed')))
		.returning({ id: subscriptions.id });
	if (updated.length > 0) return 'unsubscribed';

	const row = await subscriptionByToken(token);
	if (!row) return 'invalid';
	if (row.status === 'unsubscribed') return 'already-unsubscribed';
	return 'invalid';
}

/** Drops a pending row whose confirmation mail could not be delivered. */
export async function discardPendingToken(token: string): Promise<void> {
	await db
		.delete(subscriptions)
		.where(and(eq(subscriptions.token, token), eq(subscriptions.status, 'pending')));
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
			lang: previous.lang,
			source: previous.source,
			verifiedAt: previous.verifiedAt,
			unsubscribedAt: previous.unsubscribedAt
		})
		.where(and(eq(subscriptions.token, token), eq(subscriptions.status, 'pending')));
}
