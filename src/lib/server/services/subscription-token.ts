import { randomBytes } from 'node:crypto';

/**
 * Subscription token shape (shared by the confirm/unsubscribe pages, the
 * one-click endpoint and the CSRF exemption). Kept in its own module so
 * `hooks.server.ts` can validate the shape without importing the database
 * service (a hook must stay cheap and side-effect free).
 *
 * 32 random bytes, base64url -> 43 characters.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newSubscriptionToken(): string {
	return randomBytes(32).toString('base64url');
}

export function isSubscriptionToken(value: string): boolean {
	return TOKEN_RE.test(value);
}
