import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { subscriptions } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';

/**
 * Double opt-in subscriptions (deploy batch D-2; schema from ledger §26).
 *
 * State machine: pending → subscribed → unsubscribed. Resubmitting the form
 * for an already-subscribed address is a **no-op** — otherwise anyone could
 * knock a confirmed reader back to pending by typing their address. The token
 * is the only credential and stays valid after confirmation so the
 * unsubscribe link keeps working (it is not a single-use nonce).
 *
 * No IP/UA is stored (schema and privacy line); the pending 30-day sweep is a
 * registered follow-up.
 */

export type SubscriptionLang = 'en' | 'zh-cn' | 'ja';
export type SubscriptionStatus = 'pending' | 'subscribed' | 'unsubscribed';

const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 32 random bytes, base64url → 43 chars. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	if (email.length === 0 || email.length > EMAIL_MAX) return null;
	if (!EMAIL_RE.test(email)) return null;
	return email;
}

export function isSubscriptionLang(value: string): value is SubscriptionLang {
	return value === 'en' || value === 'zh-cn' || value === 'ja';
}

export function newSubscriptionToken(): string {
	return randomBytes(32).toString('base64url');
}

export function isSubscriptionToken(value: string): boolean {
	return TOKEN_RE.test(value);
}

export type RequestSubscriptionResult =
	{ kind: 'pending'; token: string } | { kind: 'already-subscribed' };

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

	const token = newSubscriptionToken();
	if (existing) {
		// pending (resend) or unsubscribed (re-subscribe): a fresh token is the
		// only valid confirmation link; verified_at returns to null per the
		// monotonic-timestamp CHECK.
		await db
			.update(subscriptions)
			.set({
				status: 'pending',
				token,
				lang: input.lang,
				source: input.source,
				verifiedAt: null
			})
			.where(eq(subscriptions.id, existing.id));
		return { kind: 'pending', token };
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
			if (again?.status === 'subscribed') return { kind: 'already-subscribed' };
			return { kind: 'pending', token: again?.token ?? token };
		}
		throw error;
	}

	return { kind: 'pending', token };
}

export interface SubscriptionLookup {
	status: SubscriptionStatus;
	email: string;
}

export async function subscriptionByToken(token: string): Promise<SubscriptionLookup | null> {
	if (!isSubscriptionToken(token)) return null;
	const [row] = await db
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.token, token))
		.limit(1);
	if (!row) return null;
	return { status: row.status as SubscriptionStatus, email: row.email };
}

export type ConfirmResult = 'subscribed' | 'already-subscribed' | 'unsubscribed' | 'invalid';

export async function confirmSubscription(token: string): Promise<ConfirmResult> {
	const row = await subscriptionByToken(token);
	if (!row) return 'invalid';
	if (row.status === 'subscribed') return 'already-subscribed';
	if (row.status === 'unsubscribed') return 'unsubscribed';
	await db
		.update(subscriptions)
		.set({ status: 'subscribed', verifiedAt: new Date() })
		.where(eq(subscriptions.token, token));
	return 'subscribed';
}

export type UnsubscribeResult = 'unsubscribed' | 'already-unsubscribed' | 'invalid';

export async function unsubscribe(token: string): Promise<UnsubscribeResult> {
	const row = await subscriptionByToken(token);
	if (!row) return 'invalid';
	if (row.status === 'unsubscribed') return 'already-unsubscribed';
	await db
		.update(subscriptions)
		.set({ status: 'unsubscribed', unsubscribedAt: new Date() })
		.where(eq(subscriptions.token, token));
	return 'unsubscribed';
}
