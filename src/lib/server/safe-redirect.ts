const FALLBACK = '/admin';

interface SafeRedirectOptions {
	allowedPrefix?: string;
}

export function safeRedirect(
	url: string | null | undefined,
	fallback = FALLBACK,
	options?: SafeRedirectOptions
): string {
	if (!url) return fallback;
	const trimmed = url.trim();

	// Reject external URLs starting with http://, https://, // or \
	if (
		trimmed.startsWith('http://') ||
		trimmed.startsWith('https://') ||
		trimmed.startsWith('//') ||
		trimmed.startsWith('\\')
	) {
		return fallback;
	}

	// Only allow relative paths that start with / and contain no //
	if (trimmed.startsWith('/') && !trimmed.includes('//')) {
		if (options?.allowedPrefix && !trimmed.startsWith(options.allowedPrefix)) {
			return fallback;
		}

		return trimmed;
	}

	return fallback;
}
