/**
 * IP / CIDR helpers for request-time privacy and anti-abuse decisions (W6.2,
 * W6.10). Pure string/BigInt code: no Node APIs, so the admin form can
 * validate CIDRs on the client with the exact same parser the service uses.
 *
 * Policy (decision register C2/C4, 3B.4):
 *   - the raw commenter IP is never stored; it is matched here and dropped;
 *   - blocked CIDRs live in options and are matched per request;
 *   - IPv6 rate-limit buckets aggregate the /64 a client actually controls.
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
	version: IpVersion;
	/** Network-order value: 32-bit for v4, 128-bit for v6. */
	value: bigint;
}

export interface ParsedCidr {
	version: IpVersion;
	value: bigint;
	prefix: number;
}

/** Strip a zone index (`fe80::1%eth0`) and surrounding whitespace/brackets. */
function clean(raw: string): string {
	const trimmed = raw.trim();
	const bracketed =
		trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
	return bracketed.replace(/%.*$/, '');
}

function parseIpv4(raw: string): bigint | null {
	const parts = raw.split('.');
	if (parts.length !== 4) return null;
	let value = 0n;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = (value << 8n) | BigInt(octet);
	}
	return value;
}

function parseIpv6(raw: string): bigint | null {
	// IPv4-mapped / IPv4-compatible tails (`::ffff:192.0.2.1`): parse the
	// dotted quad as two hextets, then fall through to the normal path.
	let text = raw;
	const lastColon = text.lastIndexOf(':');
	if (lastColon >= 0 && text.slice(lastColon + 1).includes('.')) {
		const v4 = parseIpv4(text.slice(lastColon + 1));
		if (v4 === null) return null;
		const hi = (v4 >> 16n) & 0xffffn;
		const lo = v4 & 0xffffn;
		text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const parseGroups = (part: string): string[] | null => {
		if (part === '') return [];
		const groups = part.split(':');
		return groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group)) ? groups : null;
	};
	const head = parseGroups(halves[0]);
	const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
	if (head === null || tail === null) return null;
	const total = head.length + tail.length;
	if (halves.length === 1 ? total !== 8 : total > 7) return null;
	const groups = halves.length === 2 ? [...head, ...Array(8 - total).fill('0'), ...tail] : head;
	let value = 0n;
	for (const group of groups) value = (value << 16n) | BigInt(parseInt(group, 16));
	return value;
}

/** Parse an IPv4/IPv6 address. Returns null for anything ambiguous. */
export function parseIp(raw: string): ParsedIp | null {
	const text = clean(raw);
	if (text === '') return null;
	if (text.includes(':')) {
		const value = parseIpv6(text);
		return value === null ? null : { version: 6, value };
	}
	const value = parseIpv4(text);
	return value === null ? null : { version: 4, value };
}

/** Parse `address/prefix`; a bare address is accepted as a host route (/32, /128). */
export function parseCidr(raw: string): ParsedCidr | null {
	const text = clean(raw);
	if (text === '') return null;
	const slash = text.indexOf('/');
	const address = slash === -1 ? text : text.slice(0, slash);
	const ip = parseIp(address);
	if (!ip) return null;
	const bits = ip.version === 4 ? 32 : 128;
	let prefix = bits;
	if (slash !== -1) {
		const tail = text.slice(slash + 1);
		if (!/^\d{1,3}$/.test(tail)) return null;
		prefix = Number(tail);
		if (prefix > bits) return null;
	}
	// Normalise the network address so comparisons never depend on host bits.
	const hostBits = BigInt(bits - prefix);
	const value = hostBits === 0n ? ip.value : (ip.value >> hostBits) << hostBits;
	return { version: ip.version, value, prefix };
}

export function isValidCidr(raw: string): boolean {
	return parseCidr(raw) !== null;
}

/** True when `ip` falls inside `cidr` (versions must match). */
export function ipInCidr(ip: ParsedIp, cidr: ParsedCidr): boolean {
	if (ip.version !== cidr.version) return false;
	const bits = ip.version === 4 ? 32 : 128;
	const hostBits = BigInt(bits - cidr.prefix);
	const masked = hostBits === 0n ? ip.value : (ip.value >> hostBits) << hostBits;
	return masked === cidr.value;
}

/** True when any configured CIDR matches; invalid entries are skipped. */
export function ipMatchesCidrs(rawIp: string, cidrs: readonly string[]): boolean {
	const ip = parseIp(rawIp);
	if (!ip || cidrs.length === 0) return false;
	for (const entry of cidrs) {
		const cidr = parseCidr(entry);
		if (cidr && ipInCidr(ip, cidr)) return true;
	}
	return false;
}

/**
 * Bucket key for per-IP limits. IPv4 keeps the exact address; IPv6 collapses
 * to its /64 so a client rotating inside its own subnet cannot multiply its
 * budget (the /64 is the smallest prefix a residential subscriber normally
 * controls). Unknown/empty addresses share one bucket so a caller without an
 * address cannot bypass a limit by omission.
 */
export function clientAddressKey(raw: string | null | undefined): string {
	const ip = parseIp(raw ?? '');
	if (!ip) return 'unknown';
	if (ip.version === 4) {
		const value = ip.value.toString(16).padStart(8, '0');
		return `4:${value}`;
	}
	const prefix = parseCidr(`${formatIpv6(ip.value)}/64`);
	return prefix ? `6:${prefix.value.toString(16)}:64` : `6:${ip.value.toString(16)}`;
}

function formatIpv6(value: bigint): string {
	const groups: string[] = [];
	for (let shift = 112n; shift >= 0n; shift -= 16n) {
		groups.push(((value >> shift) & 0xffffn).toString(16));
	}
	return groups.join(':');
}
