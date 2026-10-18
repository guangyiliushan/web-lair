/** One shared fallback for form actions that rate-limit per client. */
export function requestAddress(getClientAddress: () => string): string {
	try {
		return getClientAddress() || 'unknown';
	} catch {
		return 'unknown';
	}
}
