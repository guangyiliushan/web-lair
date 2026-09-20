import { error, isHttpError } from '@sveltejs/kit';
import { promises as dns } from 'node:dns';
import { BlockList } from 'node:net';
import { canonicalHost, EMBED_PROVIDER_DOMAINS } from '$lib/components/markdown/embed/registry';

/**
 * Favicon proxy (spec 6) — the only server-side fetch the renderer performs.
 *
 * Contract:
 * - allowlist: registry domains only, derived from the registry so the two
 *   cannot drift (a leading `www.` is canonicalised away); https only
 * - SSRF: the hostname is resolved first and every non-global range is
 *   rejected (node:net BlockList covers private, loopback, link-local,
 *   CGNAT, TEST-NET, multicast, reserved, IPv6 ULA and v4-mapped forms);
 *   redirects are not followed (`redirect: 'error'`). Residual DNS-rebinding
 *   risk (resolve-then-connect TOCTOU) is a registered hardening item —
 *   the fetch is HTTPS with certificate validation, which is what keeps it
 *   unexploitable for allowlisted hosts.
 * - limits: 5 s timeout, a streaming 512 KiB body cap (the reader is the
 *   memory bound — arrayBuffer would buffer an unbounded body), a raster
 *   image content-type allowlist (SVG is excluded: it would render
 *   same-origin if navigated to) and `X-Content-Type-Options: nosniff`; the
 *   response is cached for a day and marked no-referrer
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

const BLOCKED_RANGES = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
	['255.255.255.255', 32]
] as const) {
	BLOCKED_RANGES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
	['::', 128],
	['::1', 128],
	['64:ff9b::', 96], // NAT64 (pure v6 form)
	['2002::', 16], // 6to4 (pure v6 form)
	['fc00::', 7],
	['fe80::', 10],
	['2001:db8::', 32]
] as const) {
	BLOCKED_RANGES.addSubnet(network, prefix, 'ipv6');
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True when the address is not a globally routable unicast address.
 *
 * v4-mapped forms (`::ffff:127.0.0.1` and the hex spelling `::ffff:7f00:1`)
 * are unpacked by hand and the embedded v4 is classified instead: Node's
 * BlockList normalises every v4 string to its mapped form, so a blanket
 * `::ffff:0:0/96` rule would match ALL addresses. Unparsable mapped forms
 * fail closed.
 */
export function isPrivateAddress(address: string): boolean {
	const clean = address.includes('%') ? address.slice(0, address.indexOf('%')) : address;
	const lower = clean.toLowerCase();
	if (lower.startsWith('::ffff:')) {
		const rest = lower.slice('::ffff:'.length);
		if (IPV4.test(rest)) return isPrivateAddress(rest);
		const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
		if (hex) {
			const hi = parseInt(hex[1], 16);
			const lo = parseInt(hex[2], 16);
			return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
		}
		return true;
	}
	return BLOCKED_RANGES.check(clean, lower.includes(':') ? 'ipv6' : 'ipv4');
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
		const response = await fetch(`https://${host}/favicon.ico`, {
			signal: controller.signal,
			redirect: 'error',
			headers: { accept: 'image/*' }
		});
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
