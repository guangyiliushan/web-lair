import { error, isHttpError } from '@sveltejs/kit';
import { promises as dns } from 'node:dns';
import { canonicalHost, EMBED_PROVIDER_DOMAINS } from '$lib/components/markdown/embed/registry';
// SSRF guard shared with the links checker: the blocklist and
// `isPrivateAddress` live in `security/ssrf-guard.ts` (the single import
// point).
import { isPrivateAddress, resolvesPublic } from './security/ssrf-guard.ts';

/**
 * Favicon proxy (spec 6) — the only server-side fetch the renderer performs.
 * - allowlist: registry domains only, derived from the registry so the two cannot drift
 *   (a leading `www.` canonicalised away); https only.
 * - SSRF: hostname resolved first, every non-global range rejected (node:net BlockList:
 *   private, loopback, link-local, CGNAT, TEST-NET, multicast, reserved, IPv6 ULA,
 *   v4-mapped). Redirects followed manually (max 3 hops), each hop re-validated — https,
 *   allowlist, non-private DNS. Residual resolve-then-connect rebinding is blocked by
 *   HTTPS certificate validation for these hosts; `pinnedLookup` in
 *   `security/ssrf-guard.ts` closes the same gap for the links checker.
 * - limits: 5 s timeout, streaming 512 KiB body cap (the reader is the memory bound),
 *   raster image content-type allowlist (SVG excluded: same-origin if navigated to),
 *   `X-Content-Type-Options: nosniff`; response cached a day, no-referrer.
 */
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const ALLOWED_CONTENT_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/x-icon',
	'image/vnd.microsoft.icon',
	'image/avif'
]);

const MAX_REDIRECTS = 3;

/**
 * Fetches the favicon, following redirects manually: `redirect: 'follow'`
 * would make the final target unvalidated, and `redirect: 'error'` breaks
 * hosts that legitimately 301 their /favicon.ico. Each hop is re-checked
 * (https, allowlist, non-private DNS) before it is requested.
 */
async function fetchFavicon(host: string, signal: AbortSignal): Promise<Response> {
	let target = new URL(`https://${host}/favicon.ico`);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		const response = await fetch(target, {
			signal,
			redirect: 'manual',
			headers: { accept: 'image/*' }
		});
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get('location');
		if (!location) throw error(502, 'redirect without location');
		let next: URL;
		try {
			next = new URL(location, target);
		} catch {
			throw error(502, 'invalid redirect target');
		}
		if (next.protocol !== 'https:') throw error(403, 'redirected off https');
		const nextHost = canonicalHost(next.hostname);
		if (!EMBED_PROVIDER_DOMAINS.has(nextHost)) throw error(403, 'redirected outside the allowlist');
		// The shared guard throws on DNS failure: keep the
		// historical favicon semantics - a hop that cannot be validated is a
		// blocked redirect (403), not a 502 fetch failure.
		const publicHop = await resolvesPublic(nextHost).catch(() => false);
		if (!publicHop) throw error(403, 'blocked redirect address');
		target = next;
	}
	throw error(502, 'too many redirects');
}

export async function handleFaviconRequest(requestUrl: URL): Promise<Response> {
	const target = requestUrl.searchParams.get('url');
	if (!target) throw error(400, 'missing url');

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		throw error(400, 'invalid url');
	}
	if (parsed.protocol !== 'https:') throw error(400, 'invalid protocol');
	const host = canonicalHost(parsed.hostname);
	if (!EMBED_PROVIDER_DOMAINS.has(host)) throw error(403, 'domain not allowlisted');

	let addresses: { address: string }[];
	try {
		addresses = await dns.lookup(host, { all: true });
	} catch {
		throw error(502, 'dns failure');
	}
	if (addresses.length === 0) throw error(403, 'no address');
	if (addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw error(403, 'blocked address');
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetchFavicon(host, controller.signal);
		if (!response.ok || !response.body) throw error(502, 'upstream error');

		const contentType = (response.headers.get('content-type') ?? '')
			.split(';', 1)[0]
			.trim()
			.toLowerCase();
		if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw error(502, 'not a supported image');

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BYTES) {
				await reader.cancel();
				throw error(502, 'favicon too large');
			}
			chunks.push(value);
		}
		const body = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new Response(body, {
			headers: {
				'content-type': contentType,
				'content-length': String(total),
				'x-content-type-options': 'nosniff',
				'cache-control': 'public, max-age=86400',
				'referrer-policy': 'no-referrer'
			}
		});
	} catch (err) {
		if (isHttpError(err)) throw err;
		throw error(502, 'fetch failed');
	} finally {
		clearTimeout(timer);
	}
}
