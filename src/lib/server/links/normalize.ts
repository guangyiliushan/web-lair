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

export interface NormalizedUrl {
	/** Canonical https URL: no fragment, `:443` dropped, trailing slash trimmed (root keeps `/`). */
	url: string;
	/** Matching host: lowercase, punycode, `www.` stripped. */
	host: string;
	pathname: string;
}

export function normalizeUrl(input: string): NormalizedUrl | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	if (url.port === '443') url.port = '';
	url.hash = '';
	if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
		url.pathname = url.pathname.replace(/\/+$/, '');
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!hostname) return null;
	return { url: url.href, host: stripWww(hostname), pathname: url.pathname };
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
