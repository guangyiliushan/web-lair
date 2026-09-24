import { execFileSync } from 'node:child_process';
import { env } from '$env/dynamic/private';
import {
	resolveIdentity,
	shouldAttemptSignIn,
	parseTrustedLogins,
	type TailscaleIdentity,
	type WhoIsResult
} from './identity';

export type { TailscaleIdentity, WhoIsResult } from './identity';

const WHOIS_TIMEOUT_MS = 3_000;
const WHOIS_CACHE_TTL_MS = 60_000;

/** ip -> {at, result}; ~24 ms per call idle, up to ~0.17 s under load (measured). */
const whoisCache = new Map<string, { at: number; result: WhoIsResult | null }>();

/**
 * Path to the Tailscale CLI. The Windows installer does not put it on PATH, so
 * the absolute default matters (override with TAILSCALE_CLI). Node requires
 * forward slashes here — backslashes are eaten by the spawn argument handling.
 */
export function tailscaleCliPath(): string {
	const configured = env.TAILSCALE_CLI?.trim();
	if (configured) return configured;
	return process.platform === 'win32' ? 'C:/Program Files/Tailscale/tailscale.exe' : 'tailscale';
}

/**
 * Resolves a tailnet peer address to its login name. Never logs or returns the
 * raw payload: `whois --json` carries node keys, Hostinfo and the account
 * address, none of which belong in logs.
 */
export function whoisLookup(address: string): WhoIsResult | null {
	const now = Date.now();
	const cached = whoisCache.get(address);
	if (cached && now - cached.at < WHOIS_CACHE_TTL_MS) return cached.result;

	let result: WhoIsResult | null = null;
	try {
		const raw = execFileSync(tailscaleCliPath(), ['whois', '--json', address], {
			encoding: 'utf8',
			timeout: WHOIS_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true
		});
		const parsed = JSON.parse(raw) as {
			Node?: { Name?: string; ComputedName?: string };
			UserProfile?: { LoginName?: string };
		};
		const login = parsed.UserProfile?.LoginName?.trim().toLowerCase() ?? null;
		if (login) result = { login, node: parsed.Node?.ComputedName ?? parsed.Node?.Name ?? null };
	} catch {
		// CLI missing, timeout, or "peer not found" -> untrusted, fail closed.
		result = null;
	}

	whoisCache.set(address, { at: now, result });
	return result;
}

/** Loopback sign-in is implicit in `vite dev`; elsewhere it must be switched on. */
export function isLoopbackSignInAllowed(): boolean {
	const explicitlyEnabled = env.TAILSCALE_ALLOW_LOOPBACK === 'true';
	if (explicitlyEnabled && !import.meta.env.DEV) warnLoopbackOnce();
	return import.meta.env.DEV || explicitlyEnabled;
}

let warnedAboutLoopback = false;

/**
 * One-off warning: with the flag on, *any* request reaching this process over
 * plain loopback signs in as the site owner - so the app must stay bound to
 * 127.0.0.1 and must never be exposed through `tailscale serve` / Funnel
 * (Funnel traffic carries no identity header and would count as local).
 */
function warnLoopbackOnce() {
	if (warnedAboutLoopback) return;
	warnedAboutLoopback = true;
	console.warn(
		'[tailscale-auth] TAILSCALE_ALLOW_LOOPBACK is enabled: loopback requests sign in as the site owner. Keep the app bound to 127.0.0.1 and do not expose it through tailscale serve / Funnel.'
	);
}

/** Dev-only escape hatch; the DEV guard is what ledger §4.27 洞③ asked for. */
function isDevAdminBypass(): boolean {
	return import.meta.env.DEV && env.DEV_ADMIN_BYPASS === 'true';
}

/** Identity of the current request, or null when it cannot be trusted. */
export function resolveTailscaleIdentity(
	clientAddress: string,
	headers: Headers
): TailscaleIdentity | null {
	return resolveIdentity({
		clientAddress,
		headers,
		trustedLogins: parseTrustedLogins(env.TAILSCALE_OWNER_LOGINS),
		allowLoopback: isLoopbackSignInAllowed(),
		forceLocal: isDevAdminBypass(),
		whois: whoisLookup
	});
}

export function shouldAttemptTailscaleSignIn(clientAddress: string, headers: Headers): boolean {
	return shouldAttemptSignIn({
		clientAddress,
		headers,
		allowLoopback: isLoopbackSignInAllowed(),
		forceLocal: isDevAdminBypass()
	});
}
