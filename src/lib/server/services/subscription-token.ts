import { createHash, randomBytes } from 'node:crypto';

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

/**
 * DB lookup hash (E2-3). A plain SHA-256 is enough here: the input is 256 bits
 * of CSPRNG output, so there is no dictionary to attack; the point is to stop
 * storing a reusable credential in plaintext.
 */
export function hashSubscriptionToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}
