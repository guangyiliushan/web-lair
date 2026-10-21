import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Subscription token shape (shared by the confirm/unsubscribe pages, the
 * one-click endpoint and the CSRF exemption). Kept in its own module so
 * `hooks.server.ts` can validate the shape without importing the database
 * service (a hook must stay cheap and side-effect free).
 *
 * 32 random bytes, base64url -> 43 characters.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Domain separation for the token derivation (F-13). Only the nonce is stored;
 * the token is `HMAC-SHA256(SUBSCRIBE_TOKEN_SECRET, label || nonce)`. A dump
 * therefore holds no usable credential, while the service can re-derive the
 * exact link it mailed (resend cooldown, failed-send rollback).
 */
const TOKEN_DERIVATION_LABEL = 'wl:subscribe:token:v1:';

/** Random per-issue nonce: 32 bytes, base64url, 43 characters. */
export function newSubscriptionNonce(): string {
	return randomBytes(32).toString('base64url');
}

/** Derive the mailed token from the stored nonce and the server secret. */
export function deriveSubscriptionToken(nonce: string, key: Buffer): string {
	return createHmac('sha256', key)
		.update(TOKEN_DERIVATION_LABEL + nonce)
		.digest('base64url');
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
