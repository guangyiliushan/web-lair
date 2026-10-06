/**
 * URL / host normalization for the links line (plan §2.1: the stored `url`
 * and `host` are canonical; matching happens on `host`).
 *
 * Pure functions, no dependencies: shared by the checker (plain-Node side)
 * and, later, the apply/admin surfaces.
 */

/** Strip a single leading `www.` (the canonical host used for matching). */
export function stripWww(host: string): string {
	return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Normalize a hostname for matching: lowercase, punycode (via `URL`), a
 * trailing dot removed, `www.` stripped. Returns null for empty/unparsable
 * input. `input` may be a bare host or a full URL.
 */
export function normalizeHost(input: string): string | null {
	const raw = input.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
		const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
		return hostname ? stripWww(hostname) : null;
	} catch {
		return null;
	}
}

/**
 * Same-site test for the offsite signal (plan §4.8, coarse on purpose —
 * PSL is a registered future item): equal hosts, or either one a dotted
 * suffix of the other (`blog.example.com` ~ `example.com`).
 */
export function isSameSite(a: string, b: string): boolean {
	const x = normalizeHost(a);
	const y = normalizeHost(b);
	if (!x || !y) return false;
	return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Strip URL userinfo (`://user:pass@`) from free text before it reaches a
 * log line or the evidence ring (undici embeds the full URL in some
 * TypeError messages; review round 4).
 */
export function redactCredentials(text: string): string {
	return text.replace(/:\/\/[^\s/@]+@/g, '://[redacted]@');
}

/** Fetch-comparison key: href with the fragment removed (null = invalid). */
export function urlKey(input: string): string | null {
	try {
		const url = new URL(input);
		url.hash = '';
		return url.href;
	} catch {
		return null;
	}
}
