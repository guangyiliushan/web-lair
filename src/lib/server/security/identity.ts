/**
 * Pure identity helpers for the Tailscale sign-in path.
 *
 * Deliberately dependency-free: the same module is used by the SvelteKit
 * runtime and by the unit tests that exercise the *untrusted* branches, which
 * the e2e suite can no longer reach (a spoofed `x-real-ip` header no longer
 * resolves to a trusted identity — ledger §4.27 洞①).
 */

/** Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. */
const TAILSCALE_CIDR_START = ip4ToInt('100.64.0.0');
const TAILSCALE_CIDR_END = ip4ToInt('100.127.255.255');

/** `tailscale serve` injects this header; it is only trusted on loopback. */
export const SERVE_LOGIN_HEADER = 'tailscale-user-login';

export type IdentitySource = 'loopback' | 'serve-header' | 'whois';

export interface TailscaleIdentity {
	kind: 'local' | 'tailnet';
	source: IdentitySource;
	/** Tailnet login name (serve-header / whois only); NOT necessarily an email. */
	login: string | null;
	node: string | null;
}

export interface WhoIsResult {
	login: string;
	node: string | null;
}

function ip4ToInt(ip: string): number {
	const parts = ip.split('.');
	if (parts.length !== 4) return Number.NaN;
	let acc = 0;
	for (const part of parts) {
		const octet = Number(part);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return Number.NaN;
		acc = (acc << 8) + octet;
	}
	return acc >>> 0;
}

/** Undoes IPv6-mapping/brackets so that `::ffff:127.0.0.1` compares as `127.0.0.1`. */
export function normalizeAddress(address: string | null | undefined): string | null {
	if (!address) return null;
	let value = address.trim().toLowerCase();
	if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
	if (value.startsWith('::ffff:')) value = value.slice(7);
	return value || null;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
	const ip = normalizeAddress(address);
	return ip === '127.0.0.1' || ip === '::1';
}

export function isTailscaleAddress(address: string | null | undefined): boolean {
	const ip = normalizeAddress(address);
	if (!ip) return false;
	const int = ip4ToInt(ip);
	return Number.isFinite(int) && int >= TAILSCALE_CIDR_START && int <= TAILSCALE_CIDR_END;
}

/** Parses the env allowlist: comma/whitespace separated tailnet logins (`name@github`). */
export function parseTrustedLogins(raw: string | null | undefined): string[] {
	return (raw ?? '')
		.split(/[\s,]+/)
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
}

export function isTrustedLogin(login: string | null | undefined, trustedLogins: string[]): boolean {
	if (!login) return false;
	return trustedLogins.includes(login.trim().toLowerCase());
}

export interface IdentityProbe {
	clientAddress: string | null | undefined;
	headers: Headers;
	trustedLogins: string[];
	/** Loopback sign-in outside `vite dev` is opt-in (TAILSCALE_ALLOW_LOOPBACK). */
	allowLoopback: boolean;
	/** Dev-only escape hatch: DEV_ADMIN_BYPASS inside `import.meta.env.DEV`. */
	forceLocal?: boolean;
	/** Resolves a tailnet source address; returns null when it cannot be resolved. */
	whois?: (address: string) => WhoIsResult | null;
}

/**
 * Resolves the identity behind a request. Three sources, one exit:
 *
 *  1. `serve-header` — `tailscale serve` terminates on loopback and injects the
 *     caller's login. Only honoured for loopback connections, so a remote client
 *     cannot forge it (a client-supplied header over a non-loopback connection
 *     never reaches this branch).
 *  2. `whois` — the app listens on the tailnet directly; the peer address is
 *     resolved by the local daemon (`tailscale whois`), which no client can fake.
 *  3. `loopback` — the machine itself (dev / preview / e2e), opt-in outside dev.
 */
export function resolveIdentity(probe: IdentityProbe): TailscaleIdentity | null {
	if (probe.forceLocal) {
		return { kind: 'local', source: 'loopback', login: null, node: null };
	}

	const ip = normalizeAddress(probe.clientAddress);
	if (!ip) return null;

	if (isLoopbackAddress(ip)) {
		const headerLogin = probe.headers.get(SERVE_LOGIN_HEADER)?.trim().toLowerCase() ?? null;
		if (headerLogin && isTrustedLogin(headerLogin, probe.trustedLogins)) {
			return { kind: 'tailnet', source: 'serve-header', login: headerLogin, node: null };
		}
		if (probe.allowLoopback) {
			return { kind: 'local', source: 'loopback', login: null, node: null };
		}
		return null;
	}

	if (!isTailscaleAddress(ip) || !probe.whois) return null;

	const resolved = probe.whois(ip);
	if (!resolved || !isTrustedLogin(resolved.login, probe.trustedLogins)) return null;

	return { kind: 'tailnet', source: 'whois', login: resolved.login, node: resolved.node };
}

/** Whether a request is worth handing to the sign-in endpoint at all. */
export function shouldAttemptSignIn(options: {
	clientAddress: string | null | undefined;
	headers: Headers;
	allowLoopback: boolean;
	forceLocal?: boolean;
}): boolean {
	if (options.forceLocal) return true;
	const ip = normalizeAddress(options.clientAddress);
	if (!ip) return false;
	if (isTailscaleAddress(ip)) return true;
	if (!isLoopbackAddress(ip)) return false;
	if (options.allowLoopback) return true;
	return Boolean(options.headers.get(SERVE_LOGIN_HEADER)?.trim());
}
