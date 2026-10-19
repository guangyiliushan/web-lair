import { createHmac } from 'node:crypto';

/**
 * Keyed email hashing for rate-limit buckets and (E2) the suppression list.
 *
 * Emails are low-entropy identifiers, so a bare SHA-256 would be reversible by
 * a dictionary attack if the database leaked. Each domain gets its own key
 * (never the auth secret: rotating that must not orphan suppression rows).
 *
 * Keys are 32 random bytes, base64. `openssl rand -base64 32`.
 */
export function decodeHmacKey(raw: string | undefined): Buffer | null {
	const value = (raw ?? '').trim();
	if (!value) return null;
	// Reject non-standard alphabets explicitly: Buffer.from silently skips
	// them, so a typo could otherwise decode to 32 bytes and be accepted.
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
	const key = Buffer.from(value, 'base64');
	return key.length === 32 ? key : null;
}

export function hashEmail(email: string, key: Buffer): string {
	return createHmac('sha256', key).update(email).digest('hex');
}

const warnedKeys = new Set<string>();

/**
 * Warn once per key name, then degrade explicitly. `null` means the caller
 * must skip the keyed feature (fail-open for rate limits with a loud log),
 * never silently pretend the hash matched.
 */
export function keyedHasher(
	keyName: string,
	rawKey: string | undefined
): ((email: string) => string) | null {
	const key = decodeHmacKey(rawKey);
	if (key) return (email) => hashEmail(email, key);
	const id = `${keyName}\0${rawKey ?? ''}`;
	if (!warnedKeys.has(id)) {
		warnedKeys.add(id);
		console.warn(
			`[email-hash] ${keyName} is missing or not 32 base64-encoded bytes; the addressed feature is disabled`
		);
	}
	return null;
}
