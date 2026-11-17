import { createHash } from 'node:crypto';

/** One shared fallback for form actions that rate-limit per client. */
export function requestAddress(getClientAddress: () => string): string {
	try {
		return getClientAddress() || 'unknown';
	} catch {
		return 'unknown';
	}
}

/**
 * Request IP for privacy decisions: null when the adapter cannot
 * resolve one. Kept separate from `requestAddress` so a bucket key never
 * silently becomes a CIDR candidate.
 */
export function requestIp(getClientAddress: () => string): string | null {
	try {
		return getClientAddress() || null;
	} catch {
		return null;
	}
}

/**
 * Credentials bucket key: keying login only on the address
 * lets one NAT/office IP exhaust the budget for everybody. Mix in a truncated
 * SHA-256 of the submitted email so each account gets its own window; the
 * email itself never reaches Valkey.
 */
export function credentialBucketKey(
	scope: 'login' | 'admin-login',
	addressKey: string,
	email: string
): string {
	const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
	return `limits:${scope}:${addressKey}:${digest}`;
}
