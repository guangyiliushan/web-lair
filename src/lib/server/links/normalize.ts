// URL / host normalization for the links line: the stored `url` and `host`
// are canonical; matching happens on `host`.
//
// Pure functions, no dependencies: shared by the checker (plain-Node side)
// and, later, the apply/admin surfaces.

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
 * Same-site test for the offsite signal (coarse on purpose — PSL is a
 * registered future item): equal hosts, or either one a dotted suffix of
 * the other (`blog.example.com` ~ `example.com`).
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
 * TypeError messages).
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

/**
 * Why the stored URL cannot be canonicalised. The admin
 * surface maps every non-`subpath` reason to one "must be an https homepage"
 * message; `subpath` gets its own because the policy option can lift it.
 */
export type LinkUrlFailure =
	'invalid' | 'insecure' | 'credentials' | 'query' | 'fragment' | 'subpath';

export type NormalizeLinkUrlResult =
	{ ok: true; url: string; host: string } | { ok: false; reason: LinkUrlFailure };

/**
 * Canonical write form for `links.url`: https only, no userinfo,
 * no query/fragment, trailing slashes dropped, default ports dropped by
 * `URL`, host lowercased + punycoded + `www.`-stripped for matching. The
 * stored URL keeps the host as entered (`www.` preserved) - visitors click
 * it, and some hosts only answer on one variant.
 *
 * `allowSubPath` mirrors `friends.apply.allowSubPath`: false requires the
 * site root. The `backlink_url` column (a specific page, often `/links`)
 * always passes true.
 */
export function normalizeLinkUrl(
	input: string,
	options: { allowSubPath?: boolean } = {}
): NormalizeLinkUrlResult {
	const raw = input.trim();
	if (!raw) return { ok: false, reason: 'invalid' };
	let parsed: URL;
	try {
		// A bare host is the common admin paste; prefix https so `example.com`
		// works while an explicit `http://` still gets rejected below.
		parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	if (parsed.protocol !== 'https:') return { ok: false, reason: 'insecure' };
	if (parsed.username || parsed.password) return { ok: false, reason: 'credentials' };
	if (parsed.search) return { ok: false, reason: 'query' };
	if (parsed.hash) return { ok: false, reason: 'fragment' };
	const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
	if (!hostname) return { ok: false, reason: 'invalid' };
	const pathname = parsed.pathname.replace(/\/+$/, '');
	if (!options.allowSubPath && pathname !== '') return { ok: false, reason: 'subpath' };
	const host = stripWww(hostname);
	if (!host) return { ok: false, reason: 'invalid' };
	return { ok: true, url: `${parsed.origin}${pathname}`, host };
}
