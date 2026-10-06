import { Agent, fetch as undiciFetch } from 'undici';
import {
	pinnedLookup,
	resolvePublicAddresses,
	type ResolvedAddress
} from '../security/ssrf-guard.ts';

/**
 * The links checker's fetch unit (plan §4.2/§4.8; implementable clauses
 * decided 2026-10-06):
 * - GET only, https only, no cookies, no JS.
 * - Manual redirects: max 5 hops; every hop re-validated (https + public DNS)
 *   and re-gated by the caller's `beforeHop` hook (robots).
 * - Connection pinning: each hop dials the addresses validated in this very
 *   unit via `pinnedLookup` - never a second, unchecked lookup (the OWASP
 *   DNS-rebinding closure; TLS servername stays the hostname).
 * - One total deadline per unit (`timeoutMs` covers the whole redirect chain
 *   AND the DNS resolution and `beforeHop` gate of every hop - non-abortable
 *   steps are raced against the same signal, review finding 2026-10-06);
 *   streaming body cap (`maxBytes`).
 * - Resolver failures propagate unchanged: the caller classifies them as the
 *   site's own state (ENOTFOUND -> `dns`, counted - death detection depends
 *   on it).
 */
const MAX_REDIRECTS = 5;

const VERSION = '0.0.1'; // keep in sync with package.json
export const LINK_CHECK_PRODUCT_TOKEN = 'web-lair-link-check';
const LINK_CHECK_UA_BASE = `${LINK_CHECK_PRODUCT_TOKEN}/${VERSION}`;

/** UA per plan §4.2 / RFC 9110 §10.1.5: product token first, contact comment when ORIGIN is set. */
export function buildUserAgent(origin: string | null): string {
	return origin ? `${LINK_CHECK_UA_BASE} (+${origin}/friends)` : LINK_CHECK_UA_BASE;
}

export class LinkFetchError extends Error {
	// Note: explicit assignment, NOT a constructor parameter property -
	// Node's strip-only TypeScript mode rejects those (the builtin runs
	// under plain `node`).
	readonly code: 'ssrf' | 'non-https' | 'bad-url' | 'redirect';

	constructor(code: 'ssrf' | 'non-https' | 'bad-url' | 'redirect', message: string) {
		super(message);
		this.name = 'LinkFetchError';
		this.code = code;
	}
}

export interface FetchUnitDeps {
	/** Injectable transport (tests); defaults to undici's fetch. */
	fetch?: typeof undiciFetch;
	/** Injectable resolver (tests); defaults to the SSRF guard's resolver. */
	resolveHost?: (host: string) => Promise<ResolvedAddress[] | null>;
}

export interface FetchUnitOptions {
	userAgent: string;
	/** Total deadline for the whole unit (redirect chain + headers + body). */
	timeoutMs: number;
	/** Streaming cap for the body; excess is dropped and `truncated` set. */
	maxBytes: number;
	/** Read the body at all? Reachability checks skip it. */
	wantBody: boolean;
	/** Called before every hop; may throw to abort the fetch (robots gate). */
	beforeHop?: (url: URL) => Promise<void> | void;
}

export interface FetchUnitResult {
	finalUrl: string;
	status: number;
	contentType: string | null;
	/** `Retry-After` of the final response when present (429 evidence, §4.3). */
	retryAfter: string | null;
	body: Uint8Array | null;
	truncated: boolean;
	redirects: number;
	ms: number;
}

export async function fetchUnit(
	rawUrl: string,
	options: FetchUnitOptions,
	deps: FetchUnitDeps = {}
): Promise<FetchUnitResult> {
	const doFetch = deps.fetch ?? undiciFetch;
	const resolveHost = deps.resolveHost ?? resolvePublicAddresses;
	const signal = AbortSignal.timeout(options.timeoutMs);
	const started = Date.now();

	let target: URL;
	try {
		target = new URL(rawUrl);
	} catch {
		throw new LinkFetchError('bad-url', `invalid url: ${rawUrl}`);
	}

	let redirects = 0;
	for (;;) {
		if (target.protocol !== 'https:') {
			throw new LinkFetchError('non-https', `non-https target rejected: ${target.href}`);
		}
		const addresses = await withDeadline(resolveHost(target.hostname), signal);
		if (!addresses || addresses.length === 0) {
			throw new LinkFetchError('ssrf', `host has no public address: ${target.hostname}`);
		}
		if (options.beforeHop) await withDeadline(Promise.resolve(options.beforeHop(target)), signal);

		const agent = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
		let response: Awaited<ReturnType<typeof undiciFetch>>;
		try {
			response = await doFetch(target, {
				signal,
				redirect: 'manual',
				dispatcher: agent,
				headers: {
					'user-agent': options.userAgent,
					accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
				}
			});
		} catch (err) {
			await agent.close().catch(() => {});
			throw err;
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			await response.body?.cancel().catch(() => {});
			await agent.close().catch(() => {});
			if (!location) {
				return {
					finalUrl: target.href,
					status: response.status,
					contentType: response.headers.get('content-type'),
					retryAfter: response.headers.get('retry-after'),
					body: null,
					truncated: false,
					redirects,
					ms: Date.now() - started
				};
			}
			redirects += 1;
			if (redirects > MAX_REDIRECTS) {
				throw new LinkFetchError('redirect', `more than ${MAX_REDIRECTS} redirects`);
			}
			let next: URL;
			try {
				next = new URL(location, target);
			} catch {
				throw new LinkFetchError('redirect', 'invalid redirect location');
			}
			target = next;
			continue;
		}

		let body: Uint8Array | null = null;
		let truncated = false;
		if (options.wantBody && response.body) {
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (total + value.byteLength > options.maxBytes) {
						const keep = options.maxBytes - total;
						if (keep > 0) chunks.push(value.subarray(0, keep));
						total = options.maxBytes;
						truncated = true;
						await reader.cancel().catch(() => {});
						break;
					}
					chunks.push(value);
					total += value.byteLength;
				}
			} catch (err) {
				await reader.cancel().catch(() => {});
				await agent.close().catch(() => {});
				throw err;
			}
			body = concat(chunks, total);
		} else if (response.body) {
			await response.body.cancel().catch(() => {});
		}
		await agent.close().catch(() => {});
		return {
			finalUrl: target.href,
			status: response.status,
			contentType: response.headers.get('content-type'),
			retryAfter: response.headers.get('retry-after'),
			body,
			truncated,
			redirects,
			ms: Date.now() - started
		};
	}
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Bound a non-abortable step (DNS resolution, the robots gate) by the unit's
 * deadline: the wall clock of `timeoutMs` must cover the WHOLE unit (§4.2),
 * not just the fetch calls (review finding, 2026-10-06). The rejection
 * carries the signal's reason (a TimeoutError DOMException), so the caller's
 * classification stays `timeout`.
 */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signalReason(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signalReason(signal));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
}

function signalReason(signal: AbortSignal): unknown {
	return (
		signal.reason ?? new DOMException('The operation was aborted due to timeout', 'TimeoutError')
	);
}
