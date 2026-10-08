import type { SyncFailureKind } from './types.ts';

/**
 * Projects sync HTTP unit (plan §3.4): serial GETs against the four fixed
 * platform API hosts, 15 s timeout per request, one in-run retry for
 * timeouts / 5xx, rate-limit aware. Fixed upstream hosts are validated by
 * TLS (embed-meta precedent), so no SSRF guard applies here - the only
 * user-supplied URLs (import-url's OG fallback) go through the shared
 * security/ssrf-guard instead.
 *
 * Classification (§3.3): 404/410 -> not_found; 429 or a 403 carrying an
 * exhausted rate-limit signal -> rate_limited; other 401/403 -> auth;
 * timeout / DNS / TLS / connect / persistent 5xx -> network; a body that is
 * not the expected JSON object -> parse.
 */

/** Keep in sync with package.json (links-check precedent). */
export const PROJECTS_SYNC_VERSION = '0.0.1';
const PRODUCT_TOKEN = 'web-lair-projects-sync';

/** UA per §3.4; the contact comment appears when ORIGIN is configured. */
export function syncUserAgent(): string {
	const origin = process.env.ORIGIN;
	return origin
		? `${PRODUCT_TOKEN}/${PROJECTS_SYNC_VERSION} (+${origin}/projects)`
		: `${PRODUCT_TOKEN}/${PROJECTS_SYNC_VERSION}`;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export class ProjectsFetchError extends Error {
	// Explicit assignment, not a constructor parameter property: plain Node
	// type stripping rejects those (the builtin runs under `node`).
	readonly kind: SyncFailureKind;
	readonly status: number | null;

	constructor(kind: SyncFailureKind, message: string, status: number | null = null) {
		super(message);
		this.name = 'ProjectsFetchError';
		this.kind = kind;
		this.status = status;
	}
}

export interface FetchJsonInit {
	headers?: Record<string, string>;
}

export interface FetchJsonResponse {
	status: number;
	headers: Headers;
	json: unknown;
}

/** Injectable transport shape (tests stub this; adapters consume it). */
export type FetchJson = (url: string, init?: FetchJsonInit) => Promise<FetchJsonResponse>;

/**
 * Rate-limit exhaustion probe per platform (plan §3.4). Bitbucket exposes
 * no remaining header on the probed endpoints - 429 is its only signal.
 */
export function isRateLimitExhausted(provider: string, headers: Headers): boolean {
	if (provider === 'github') return headers.get('x-ratelimit-remaining') === '0';
	if (provider === 'gitlab') return headers.get('ratelimit-remaining') === '0';
	if (provider === 'gitee') return headers.get('x-ratelimit-remaining') === '0';
	return false;
}

/**
 * Reset moment from the epoch-seconds headers (GitHub `x-ratelimit-reset`,
 * GitLab `ratelimit-reset`). Digit-capped and range-checked so a malformed
 * header can never reach `new Date(...).toISOString()` as an invalid value
 * (review 2026-10-08).
 */
export function rateLimitResetAtMs(headers: Headers): number | null {
	const raw = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset');
	if (raw === null || !/^\d{1,11}$/.test(raw)) return null;
	const ms = Number(raw) * 1000;
	return Number.isFinite(ms) && ms <= 8.64e15 ? ms : null;
}

export interface ApiFetchDeps {
	/** Injectable transport (tests); defaults to global fetch. */
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Injectable sleep (tests keep retry paths instant). */
	sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAY_MS = 1_000;
/** Longest Retry-After we will wait out inside a run (one tick budget). */
const MAX_RETRY_AFTER_MS = 30_000;

function rawRetryAfterMs(headers: Headers): number | null {
	const raw = headers.get('retry-after');
	if (raw === null) return null;
	if (/^\d+$/.test(raw)) return Number(raw) * 1000;
	const at = Date.parse(raw);
	if (!Number.isNaN(at)) return Math.max(at - Date.now(), 0);
	return null;
}

/** Upstream rate-limit signal on a 403: any of the platform headers at 0,
 * or a bare Retry-After (GitHub secondary limits carry it without zeroing
 * the primary remaining header per the REST best-practices doc). */
function isRateLimitedResponse(headers: Headers): boolean {
	const remaining =
		headers.get('x-ratelimit-remaining') ??
		headers.get('ratelimit-remaining') ??
		headers.get('x-rate-limit-remaining');
	return remaining === '0' || headers.get('retry-after') !== null;
}

const MAX_API_REDIRECTS = 3;

/**
 * Fixed-host API GET with manual redirects: follow up to
 * MAX_API_REDIRECTS hops (GitHub answers 301 for renamed repositories -
 * the API response stays the source of truth), but never leave the
 * original origin (scheme + host + port) - undici strips `authorization`
 * cross-origin yet leaves custom headers (GitLab's `private-token`)
 * intact, and a same-host downgrade/port change still resends them.
 * Fail closed instead. `signal` is the per-attempt deadline: every hop of
 * this attempt shares it, so a redirect chain cannot outlive the nominal
 * timeout (review 2026-10-08).
 */
async function doFetchWithRedirects(
	doFetch: typeof fetch,
	url: string,
	init: FetchJsonInit,
	signal: AbortSignal
): Promise<Response> {
	let target = url;
	let redirects = 0;
	for (;;) {
		const response = await doFetch(target, {
			method: 'GET',
			headers: { 'user-agent': syncUserAgent(), accept: 'application/json', ...init.headers },
			signal,
			redirect: 'manual'
		});
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get('location');
		await response.body?.cancel().catch(() => {});
		if (!location)
			throw new ProjectsFetchError('parse', 'redirect without location', response.status);
		redirects += 1;
		if (redirects > MAX_API_REDIRECTS) {
			throw new ProjectsFetchError('parse', 'too many redirects', response.status);
		}
		let next: URL;
		try {
			next = new URL(location, target);
		} catch {
			throw new ProjectsFetchError('parse', 'invalid redirect location', response.status);
		}
		// Origin-level (scheme + host + port): a same-host scheme downgrade
		// or port change would still resend credentials (review 2026-10-08).
		if (next.origin !== new URL(target).origin || next.protocol !== 'https:') {
			throw new ProjectsFetchError('parse', `cross-origin redirect rejected: ${next.origin}`);
		}
		target = next.href;
	}
}

/**
 * One GET against a fixed API host with the plan's politeness rules. The
 * response body must parse to a JSON object (arrays are wrapped by callers'
 * payload checks via `expect: 'array'`); anything else is a `parse` failure.
 */
export async function fetchJson(
	url: string,
	init: FetchJsonInit = {},
	deps: ApiFetchDeps = {}
): Promise<FetchJsonResponse> {
	const doFetch = deps.fetch ?? fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

	let attempt = 0;
	for (;;) {
		attempt += 1;
		let response: Response;
		try {
			// One deadline per attempt, covering every redirect hop of that
			// attempt (review 2026-10-08: per-hop signals let a chain exceed
			// the nominal timeout).
			response = await doFetchWithRedirects(doFetch, url, init, AbortSignal.timeout(timeoutMs));
		} catch (err) {
			// Classified redirect failures pass straight through.
			if (err instanceof ProjectsFetchError) throw err;
			// Timeouts retry once within the run (plan §3.4: one in-run
			// retry for timeouts / 5xx); other network-class failures
			// (DNS / TLS / connect) do not.
			if (attempt === 1 && err instanceof Error && err.name === 'TimeoutError') {
				await sleep(RETRY_DELAY_MS);
				continue;
			}
			throw new ProjectsFetchError('network', sanitizeMessage(err));
		}

		if (response.status === 429) {
			const waitMs = rawRetryAfterMs(response.headers);
			await response.body?.cancel().catch(() => {});
			// Plan §3.4: honour Retry-After, but only within the run budget -
			// a longer window means this account is done for this run
			// (give up the rest of its requests and record rate_limited).
			if (waitMs !== null && waitMs <= MAX_RETRY_AFTER_MS && attempt === 1) {
				await sleep(waitMs);
				continue;
			}
			throw new ProjectsFetchError(
				'rate_limited',
				`HTTP 429 (retry-after=${response.headers.get('retry-after') ?? 'n/a'})`,
				429
			);
		}
		if (response.status === 401) {
			await response.body?.cancel().catch(() => {});
			throw new ProjectsFetchError('auth', 'HTTP 401', 401);
		}
		if (response.status === 403) {
			await response.body?.cancel().catch(() => {});
			if (isRateLimitedResponse(response.headers)) {
				const resetAtMs = rateLimitResetAtMs(response.headers);
				// Same run-budget rule as 429: wait out a near reset once,
				// otherwise give up this run's requests for the account
				// (plan §3.4).
				const waitMs = resetAtMs !== null ? resetAtMs - Date.now() : null;
				if (waitMs !== null && waitMs >= 0 && waitMs <= MAX_RETRY_AFTER_MS && attempt === 1) {
					await sleep(waitMs);
					continue;
				}
				const suffix = resetAtMs !== null ? `; reset at ${new Date(resetAtMs).toISOString()}` : '';
				throw new ProjectsFetchError('rate_limited', `HTTP 403 (rate limited${suffix})`, 403);
			}
			throw new ProjectsFetchError('auth', 'HTTP 403', 403);
		}
		if (response.status === 404 || response.status === 410) {
			await response.body?.cancel().catch(() => {});
			throw new ProjectsFetchError('not_found', `HTTP ${response.status}`, response.status);
		}
		if (response.status >= 500) {
			await response.body?.cancel().catch(() => {});
			if (attempt === 1) {
				// Plan §3.4: timeout / 5xx retry once within the run.
				await sleep(RETRY_DELAY_MS);
				continue;
			}
			throw new ProjectsFetchError(
				'network',
				`HTTP ${response.status} after retry`,
				response.status
			);
		}
		if (response.status >= 400) {
			await response.body?.cancel().catch(() => {});
			throw new ProjectsFetchError(
				'network',
				`unexpected HTTP ${response.status}`,
				response.status
			);
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (err) {
			// A body-phase timeout is still a timeout (retry once, then
			// network) - never a platform shape signal (review 2026-10-08).
			if (err instanceof Error && err.name === 'TimeoutError') {
				if (attempt === 1) {
					await sleep(RETRY_DELAY_MS);
					continue;
				}
				throw new ProjectsFetchError('network', 'response body timed out');
			}
			throw new ProjectsFetchError('parse', 'response body is not JSON', response.status);
		}
		return { status: response.status, headers: response.headers, json };
	}
}

/** Bound error text for logs / last_error_kind neighbours (no secrets). */
export function sanitizeMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replaceAll(/\s+/g, ' ').slice(0, 200);
}
