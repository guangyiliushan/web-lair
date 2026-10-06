import { promises as dns } from 'node:dns';
import { BlockList } from 'node:net';

/**
 * Shared SSRF guard for server-side fetches (links line, 2026-10-06; moved
 * from `favicon-proxy.ts` so the link checker and the favicon proxy share one
 * blocklist and one resolution policy).
 *
 * Two layers, mirroring the OWASP SSRF Cheat Sheet:
 * 1. resolution-time validation: every DNS answer is checked against the
 *    non-global blocklist (fail closed) BEFORE the request is issued;
 * 2. connection-time pinning: `pinnedLookup` overrides the socket's own DNS
 *    lookup so the connection can only reach the addresses validated in
 *    step 1 - a second, unchecked lookup between validation and connection
 *    (DNS rebinding) cannot redirect it.
 *
 * `favicon-proxy.ts` still performs step 1 only and keeps its registered
 * TOCTOU residual; the links checker performs both.
 */
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

export interface ResolvedAddress {
	address: string;
	family: number;
}

/**
 * Resolve `host` and return the answers only when every one of them is
 * globally routable (fail closed). Returns null on DNS failure, an empty
 * answer set, or any private answer - callers must then refuse the request.
 */
export async function resolvePublicAddresses(host: string): Promise<ResolvedAddress[] | null> {
	const addresses = await dns.lookup(host, { all: true }).catch(() => []);
	if (addresses.length === 0) return null;
	if (addresses.some((entry) => isPrivateAddress(entry.address))) return null;
	return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

/** Boolean form used by `favicon-proxy.ts` callers. */
export async function resolvesPublic(host: string): Promise<boolean> {
	return (await resolvePublicAddresses(host)) !== null;
}

/** Node `net.connect` lookup-hook shape (undici forwards `connect.lookup`). */
export type PinnedLookup = (
	hostname: string,
	options: { all?: boolean } | undefined,
	callback: (
		err: Error | null,
		addressOrAddresses: string | ResolvedAddress[],
		family?: number
	) => void
) => void;

/**
 * Build the connection-time half of the guard: a DNS lookup hook that always
 * answers with the addresses validated by `resolvePublicAddresses` - never a
 * fresh lookup - so the validated set IS what the socket dials. TLS keeps the
 * original hostname (servername), so certificate validation is unchanged.
 */
export function pinnedLookup(addresses: ResolvedAddress[]): PinnedLookup {
	return (_hostname, options, callback) => {
		const [first] = addresses;
		if (!first) {
			// The net lookup hook contract has no arity-1 error form; the
			// address value is ignored on the error path (defensive only -
			// callers never pass an empty set).
			callback(new Error('no validated addresses'), '');
			return;
		}
		if (options?.all) callback(null, addresses);
		else callback(null, first.address, first.family);
	};
}
