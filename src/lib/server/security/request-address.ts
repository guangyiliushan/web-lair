/** One shared fallback for form actions that rate-limit per client. */
export function requestAddress(getClientAddress: () => string): string {
	try {
		return getClientAddress() || 'unknown';
	} catch {
		return 'unknown';
	}
}

/**
 * Request IP for privacy decisions (W6.2): null when the adapter cannot
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
