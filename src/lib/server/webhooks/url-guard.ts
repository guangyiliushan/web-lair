import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Webhook URL guard.
 *
 * A webhook URL decides where the server sends data, so it is an SSRF sink:
 * without a guard, an admin (or a stolen admin session) could point an
 * endpoint at the loopback interface, the cloud metadata service or any
 * RFC1918 host. The guard runs in two places:
 *
 *   1. create/update - HTTPS only, credentials refused, literal private
 *      addresses refused, and every address the hostname resolves to must be
 *      public. A resolution failure fails closed (an attacker cannot park a
 *      name that stops resolving at validation time and turns private later
 *      without changing the stored URL).
 *   2. delivery - the same literal/hostname checks plus a best-effort DNS
 *      re-check before the POST. fetch() resolves again, so a hostile DNS
 *      that flips between the check and the request remains a registered
 *      TOCTOU residual; the config-time check is the boundary that matters
 *      for an existing endpoint.
 *
 * Homelab deployments can opt into RFC1918/ULA targets with
 * `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`. Loopback, link-local (including the
 * 169.254.169.254 metadata address), multicast and documentation ranges stay
 * blocked even then: "my LAN" is not "my own process or my cloud metadata".
 */
export const WEBHOOK_ALLOW_PRIVATE_ENV = 'WEBHOOK_ALLOW_PRIVATE_TARGETS';

export type WebhookUrlRejectReason =
	'invalid_url' | 'insecure_scheme' | 'credentials' | 'blocked_host' | 'unresolvable';

export class WebhookUrlError extends Error {
	// Explicit field, not a constructor parameter property: `jobs/drain.ts`
	// loads this module under plain Node type stripping, which rejects
	// parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
	readonly reason: WebhookUrlRejectReason;

	constructor(reason: WebhookUrlRejectReason, message: string) {
		super(message);
		this.name = 'WebhookUrlError';
		this.reason = reason;
	}
}

export interface WebhookUrlGuardOptions {
	/** Permit RFC1918 / CGNAT / IPv6 ULA targets (explicit LAN opt-in). */
	allowPrivate?: boolean;
	/**
	 * Test-harness only (HTTP + 127.0.0.1 fixture servers): permit plain HTTP
	 * and loopback. Never true in production - the env helper refuses it
	 * there, and the settings page never passes it.
	 */
	allowInsecureLoopback?: boolean;
	/** Test seam: resolve every address for a hostname. */
	lookup?: (hostname: string) => Promise<string[]>;
	/** DNS deadline; a hung resolver must not hold the delivery row lock. */
	lookupTimeoutMs?: number;
}

/** DNS lookup with a hard deadline (the caller decides fail-open/closed). */
async function lookupWithin(
	lookup: (hostname: string) => Promise<string[]>,
	hostname: string,
	timeoutMs: number
): Promise<string[]> {
	return await new Promise<string[]>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('dns lookup timed out')), timeoutMs);
		lookup(hostname).then(
			(addresses) => {
				clearTimeout(timer);
				resolve(addresses);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

async function defaultLookup(hostname: string): Promise<string[]> {
	const rows = await dnsLookup(hostname, { all: true, verbatim: true });
	return rows.map((row) => row.address);
}

function parseIpv4(address: string): number[] | null {
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		if (value > 255) return null;
		octets.push(value);
	}
	return octets;
}

function expandIpv6(address: string): number[] | null {
	let value = address;
	const zone = value.indexOf('%');
	if (zone !== -1) value = value.slice(0, zone);
	// Embedded IPv4 tail (::ffff:10.0.0.1, 64:ff9b::192.0.2.1).
	const lastColon = value.lastIndexOf(':');
	if (lastColon !== -1 && value.slice(lastColon + 1).includes('.')) {
		const tail = parseIpv4(value.slice(lastColon + 1));
		if (!tail) return null;
		value =
			value.slice(0, lastColon + 1) +
			((tail[0] << 8) | tail[1]).toString(16) +
			':' +
			((tail[2] << 8) | tail[3]).toString(16);
	}
	const halves = value.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 ? missing < 0 : head.length !== 8) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
	if (groups.length !== 8) return null;
	const parsed: number[] = [];
	for (const group of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
		parsed.push(parseInt(group, 16));
	}
	return parsed;
}

function blockedIpv4(octets: number[], allowPrivate: boolean, allowLoopback: boolean): boolean {
	const [a, b, c] = octets;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return !allowPrivate;
	if (a === 100 && b >= 64 && b <= 127) return !allowPrivate; // CGNAT
	if (a === 127) return !allowLoopback; // loopback
	if (a === 169 && b === 254) return true; // link-local + cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return !allowPrivate;
	if (a === 192 && b === 0) return true; // IETF assignments (incl. 192.0.2.0/24)
	if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
	if (a === 192 && b === 168) return !allowPrivate;
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
	if (a >= 224) return true; // multicast + reserved + broadcast
	return false;
}

/**
 * True when an IP literal must not be contacted. Unparseable input fails
 * closed (a malformed address is never a valid target).
 */
export function isBlockedWebhookAddress(
	address: string,
	options: Pick<WebhookUrlGuardOptions, 'allowPrivate' | 'allowInsecureLoopback'> = {}
): boolean {
	const allowPrivate = options.allowPrivate === true;
	const allowLoopback = options.allowInsecureLoopback === true;
	const ipv4 = parseIpv4(address);
	if (ipv4) return blockedIpv4(ipv4, allowPrivate, allowLoopback);
	const ipv6 = expandIpv6(address);
	if (!ipv6) return true;
	// IPv4-mapped ::ffff:a.b.c.d carries a v4 target inside a v6 literal.
	if (ipv6.slice(0, 5).every((group) => group === 0) && ipv6[5] === 0xffff) {
		return blockedIpv4(
			[ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff],
			allowPrivate,
			allowLoopback
		);
	}
	if (ipv6.every((group) => group === 0)) return true; // ::
	if (ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1) {
		return !allowLoopback; // ::1
	}
	// IPv4-compatible ::a.b.c.d (::127.0.0.1) is deprecated but still routable
	// on some stacks; the mapped ::ffff: form was handled above.
	if (ipv6.slice(0, 6).every((group) => group === 0)) return true;
	const first = ipv6[0];
	if ((first & 0xfe00) === 0xfc00) return !allowPrivate; // fc00::/7 ULA
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
	if ((first & 0xff00) === 0xff00) return true; // multicast
	if (first === 0x2001 && ipv6[1] === 0x0db8) return true; // documentation
	if (first === 0x2001 && ipv6[1] === 0) return true; // Teredo 2001::/32
	if (first === 0x0064 && ipv6[1] === 0xff9b) return true; // NAT64
	if (first === 0x2002) return true; // 6to4
	return false;
}

/** Strip the brackets Node's URL keeps for an IPv6 hostname. */
function bareHostname(hostname: string): string {
	const lower = hostname.toLowerCase().replace(/\.$/, '');
	return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/** Literal and name-based rules that need no DNS. */
export function isBlockedWebhookHostname(
	hostname: string,
	options: Pick<WebhookUrlGuardOptions, 'allowPrivate'> = {}
): boolean {
	const host = bareHostname(hostname);
	if (!host) return true;
	if (isIP(host)) return isBlockedWebhookAddress(host, options);
	if (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		(host.endsWith('.local') && options.allowPrivate !== true) ||
		host.endsWith('.internal')
	) {
		return true;
	}
	// A single-label host is an intranet name; only the explicit LAN switch
	// may resolve it.
	if (!host.includes('.') && options.allowPrivate !== true) return true;
	return false;
}

/** True for a loopback literal or a `localhost`-style name. */
function isLoopbackHost(hostname: string): boolean {
	const host = bareHostname(hostname);
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	const ipv4 = parseIpv4(host);
	if (ipv4) return ipv4[0] === 127;
	const ipv6 = expandIpv6(host);
	if (ipv6) return ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1;
	return false;
}

function parseWebhookUrl(raw: string, options: WebhookUrlGuardOptions = {}): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new WebhookUrlError('invalid_url', 'Webhook URL is not a valid URL');
	}
	const insecureLoopback =
		options.allowInsecureLoopback === true &&
		url.protocol === 'http:' &&
		isLoopbackHost(url.hostname);
	if (url.protocol !== 'https:' && !insecureLoopback) {
		throw new WebhookUrlError('insecure_scheme', 'Webhook URLs must use https://');
	}
	if (url.username || url.password) {
		throw new WebhookUrlError('credentials', 'Webhook URLs must not embed credentials');
	}
	return url;
}

/**
 * Validate a URL for storage. Returns the WHATWG-normalized `href` (the DB
 * CHECK requires the normalized lowercase form). Throws `WebhookUrlError`;
 * the caller maps `reason` to a localized message.
 */
export async function validateWebhookUrl(
	raw: string,
	options: WebhookUrlGuardOptions = {}
): Promise<string> {
	const url = parseWebhookUrl(raw, options);
	const host = bareHostname(url.hostname);
	if (isBlockedWebhookHostname(host, options)) {
		throw new WebhookUrlError(
			'blocked_host',
			'Webhook URL points at a private, loopback or link-local target'
		);
	}
	if (!isIP(host)) {
		const lookup = options.lookup ?? defaultLookup;
		let addresses: string[];
		try {
			addresses = await lookupWithin(lookup, host, options.lookupTimeoutMs ?? 5_000);
		} catch {
			throw new WebhookUrlError('unresolvable', 'Webhook hostname could not be resolved');
		}
		if (addresses.length === 0) {
			throw new WebhookUrlError('unresolvable', 'Webhook hostname resolved to no addresses');
		}
		if (addresses.some((address) => isBlockedWebhookAddress(address, options))) {
			throw new WebhookUrlError(
				'blocked_host',
				'Webhook hostname resolves to a private, loopback or link-local address'
			);
		}
	}
	return url.href;
}

/**
 * Delivery-time pre-flight. Literal/name rules throw; a DNS failure is left
 * to fetch() (which reports a retryable network error) so an offline drain
 * does not turn a transient resolver outage into a permanent failure.
 */
export async function assertDeliveryTarget(
	raw: string,
	options: WebhookUrlGuardOptions = {}
): Promise<void> {
	const url = parseWebhookUrl(raw, options);
	const host = bareHostname(url.hostname);
	if (isBlockedWebhookHostname(host, options)) {
		throw new WebhookUrlError('blocked_host', 'Webhook target is not a public address');
	}
	if (isIP(host)) return;
	const lookup = options.lookup ?? defaultLookup;
	let addresses: string[];
	try {
		addresses = await lookupWithin(lookup, host, options.lookupTimeoutMs ?? 5_000);
	} catch {
		return;
	}
	if (addresses.some((address) => isBlockedWebhookAddress(address, options))) {
		throw new WebhookUrlError('blocked_host', 'Webhook target resolves to a blocked address');
	}
}

/** `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` is the only way to allow LAN targets. */
export function webhookAllowPrivateTargets(getEnv: (name: string) => string | undefined): boolean {
	return getEnv(WEBHOOK_ALLOW_PRIVATE_ENV)?.trim() === 'true';
}

/**
 * Guard options for the delivery path. The loopback/HTTP escape hatch is for
 * the `db:verify-jobs` fixture server only: it is ignored in production and
 * never passed by the settings page (which only allows the LAN switch).
 */
export function webhookGuardOptionsFromEnv(
	getEnv: (name: string) => string | undefined
): Pick<WebhookUrlGuardOptions, 'allowPrivate' | 'allowInsecureLoopback'> {
	return {
		allowPrivate: webhookAllowPrivateTargets(getEnv),
		allowInsecureLoopback:
			getEnv('WEBHOOK_ALLOW_INSECURE_LOOPBACK')?.trim() === 'true' &&
			(getEnv('NODE_ENV') === 'test' || getEnv('NODE_ENV') === 'development')
	};
}
