import { COOKIE_SURFACES } from '$lib/config/locale-surfaces';
import { deLocalizeUrl } from '$lib/paraglide/runtime';
import { isUuid } from '$lib/utils/uuid';

/**
 * Presence client engine (realtime R3, ledger §23): token, heartbeat loop,
 * visibility pause, position math and the SSE watchdog. All capture rules
 * and timing/recovery logic live here (unit-tested in node); the Svelte
 * components stay thin renderers.
 */

export const PRESENCE_HEARTBEAT_MS = 15_000;
/** Client floor between early position reports while scrolling (≤12/min). */
export const PRESENCE_POSITION_MS = 5_000;
/** Report early once the reading position moved this many percent. */
export const PRESENCE_POSITION_DELTA = 2;

export const PRESENCE_TOKEN_KEY = 'wl.presence.token';

/**
 * Site-heartbeat mount filter (register R-6): the cookie surfaces minus the
 * home page — /account and the five auth pages never heartbeat. The pathname
 * is canonicalised first (deLocalizeUrl, the official Paraglide reroute
 * recipe): SvelteKit's reroute keeps the address bar — and `page.url` — on
 * the language-prefixed form, so a raw match would let /zh-cn/account and
 * friends beat (review finding).
 */
export function shouldTrackPath(pathname: string): boolean {
	const canonical = deLocalizeUrl(new URL(pathname, 'https://placeholder.invalid')).pathname;
	return !COOKIE_SURFACES.some(
		(surface) => surface !== '/' && (canonical === surface || canonical.startsWith(`${surface}/`))
	);
}

function randomUuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// Non-secure contexts (LAN http) lack randomUUID; the fallbacks still
	// emit the canonical v4 layout so the server's single uuid validator
	// accepts them (register R-3, mirroring the rehype-whitelist precedent).
	const bytes = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	} else {
		for (let index = 0; index < bytes.length; index += 1) {
			bytes[index] = Math.floor(Math.random() * 256);
		}
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Module-scope fallback when sessionStorage is unavailable (private mode). */
let memoryToken: string | null = null;

export function getOrCreatePresenceToken(storage?: Pick<Storage, 'getItem' | 'setItem'>): string {
	let target = storage;
	if (!target) {
		try {
			target = sessionStorage;
		} catch {
			target = undefined;
		}
	}
	if (target) {
		try {
			const existing = target.getItem(PRESENCE_TOKEN_KEY);
			// A stale value that fails the server's isUuid gate is replaced
			// (register R-3; the validator is shared, not a second regex).
			if (existing && isUuid(existing)) return existing;
			const token = randomUuid();
			target.setItem(PRESENCE_TOKEN_KEY, token);
			return token;
		} catch {
			// fall through to the in-memory token
		}
	}
	memoryToken ??= randomUuid();
	return memoryToken;
}

export interface HeartbeatContext {
	contentId?: string;
	bucket?: number;
}

/** Minimal visibility surface (the real `document` satisfies it). */
export interface VisibilitySource {
	readonly visibilityState: DocumentVisibilityState;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

export interface HeartbeatDeps {
	/** Injectable fetch/document for tests; defaults to the globals. */
	fetch?: typeof fetch;
	document?: VisibilitySource;
	send?: (token: string, context: HeartbeatContext) => Promise<void>;
}

export async function sendPresenceHeartbeat(
	token: string,
	context: HeartbeatContext = {},
	fetchFn: typeof fetch = fetch
): Promise<void> {
	try {
		await fetchFn('/api/presence/heartbeat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				token,
				...(context.contentId !== undefined ? { c: context.contentId } : {}),
				...(context.bucket !== undefined ? { bucket: context.bucket } : {})
			}),
			keepalive: true
		});
	} catch {
		// fail-open: heartbeats are best-effort, the next tick retries
	}
}

export interface HeartbeatLoopOptions extends HeartbeatDeps {
	token: string;
	intervalMs?: number;
	/** Read the live context on every beat (bucket moves as the reader scrolls). */
	context?: () => HeartbeatContext;
}

/**
 * The tab's heartbeat loop (register D2): one immediate beat, then every
 * `intervalMs`; a hidden tab pauses outright (browsers throttle timers to
 * ~1/min in the background anyway) and returns with a single catch-up beat.
 */
export function startPresenceHeartbeat(options: HeartbeatLoopOptions): () => void {
	const doc = options.document ?? document;
	const send =
		options.send ?? ((token, context) => sendPresenceHeartbeat(token, context, options.fetch));
	const intervalMs = options.intervalMs ?? PRESENCE_HEARTBEAT_MS;
	let timer: ReturnType<typeof setInterval> | null = null;
	let stopped = false;

	const beat = (): void => {
		void send(options.token, options.context?.() ?? {});
	};
	const resume = (): void => {
		if (stopped || timer !== null) return;
		beat();
		timer = setInterval(beat, intervalMs);
	};
	const pause = (): void => {
		if (timer === null) return;
		clearInterval(timer);
		timer = null;
	};
	const onVisibility = (): void => {
		if (doc.visibilityState === 'hidden') pause();
		else resume();
	};

	doc.addEventListener('visibilitychange', onVisibility);
	if (doc.visibilityState !== 'hidden') resume();

	return () => {
		stopped = true;
		pause();
		doc.removeEventListener('visibilitychange', onVisibility);
	};
}

export interface StreamEventSource {
	readonly readyState: number;
	addEventListener(type: string, listener: (event: Event) => void): void;
	close(): void;
}

type StreamConstructor = new (url: string) => StreamEventSource;

export interface PresenceStreamOptions {
	url: string;
	onSnapshot: (payload: unknown) => void;
	/** Injectable for tests; defaults to the global EventSource. */
	eventSource?: StreamConstructor;
	/** Injectable visibility source for tests; defaults to the global document. */
	document?: VisibilitySource;
}

export const STREAM_RETRY_BASE_MS = 5_000;
export const STREAM_RETRY_MAX_MS = 60_000;
/** Rebuild attempts that never opened: bounded so a 204/4xx cannot loop. */
export const STREAM_COLD_RETRY_LIMIT = 5;
/**
 * After the cold-retry cap the stream degrades to ONE probe per 10 minutes
 * instead of going silent forever (review finding): a deploy-window 502 left
 * the tab dark until a reload, and a re-enabled feature never revived it.
 * One attempt per interval is not a loop — the disabled-204 guarantee holds.
 */
export const STREAM_SETTLE_PROBE_MS = 10 * 60_000;

/**
 * One EventSource per tab (register C2/C3) with the fatal-failure watchdog
 * (C3): non-200 failures are permanent per the spec, so we rebuild with
 * exponential backoff capped at 60s; after the cold cap the stream settles to
 * a single probe every 10 minutes, and a visibilitychange back to visible
 * suspends/resumes with reset counters (a hidden tab also stops holding a
 * connection — the HTTP/1.1 six-connection budget). CONNECTING errors stay
 * the browser's job; stop() goes silent for good.
 */
export function openPresenceStream(options: PresenceStreamOptions): () => void {
	const Constructor = options.eventSource ?? (EventSource as unknown as StreamConstructor);
	const doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
	let source: StreamEventSource | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let attempt = 0;
	let coldRetries = 0;
	let stopped = false;
	let suspended = false;
	let probing = false;

	const clearTimers = (): void => {
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		if (settleTimer !== null) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}
	};

	const onVisibility = (): void => {
		if (stopped) return;
		if (doc?.visibilityState === 'hidden') {
			// Release the connection while backgrounded (h1.1 budget); this is
			// not a failure, so the cold counter stays put.
			suspended = true;
			clearTimers();
			source?.close();
			source = null;
		} else if (suspended) {
			// Back to the foreground: a fresh attempt with reset counters
			// (including the probe flag — a probe killed by the suspend must
			// not demote the next failure straight to settle), so a
			// deploy-window outage or a re-enabled feature recovers here too.
			suspended = false;
			coldRetries = 0;
			attempt = 0;
			probing = false;
			connect();
		}
	};

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearTimers();
		source?.close();
		source = null;
		doc?.removeEventListener('visibilitychange', onVisibility);
	};

	const scheduleSettleProbe = (): void => {
		if (stopped || settleTimer !== null) return;
		settleTimer = setTimeout(() => {
			settleTimer = null;
			// Defensive only: every suspend/stop path clears this timer first,
			// so the guard is currently unreachable (kept for future callers).
			if (stopped || suspended) return;
			coldRetries = 0;
			attempt = 0;
			probing = true;
			connect();
		}, STREAM_SETTLE_PROBE_MS);
	};

	const connect = (): void => {
		if (stopped || suspended) return;
		const current = new Constructor(options.url);
		source = current;
		current.addEventListener('open', () => {
			attempt = 0;
			coldRetries = 0;
			probing = false;
		});
		current.addEventListener('snapshot', (event) => {
			const data = (event as MessageEvent).data;
			if (typeof data !== 'string') return;
			try {
				options.onSnapshot(JSON.parse(data));
			} catch {
				// a malformed frame is skipped; the next tick replaces it
			}
		});
		current.addEventListener('error', () => {
			if (stopped || suspended || current !== source) return;
			// CONNECTING (0) → the browser reconnects on its own; CLOSED (2) →
			// fatal (non-200 / 204 stop / bad MIME) and nothing retries.
			if (current.readyState !== 2) return;
			coldRetries += 1;
			if (coldRetries > STREAM_COLD_RETRY_LIMIT || probing) {
				// Cap reached, or a settle probe missed: quiet until the next
				// slow probe instead of a retry burst or permanent silence.
				source = null;
				current.close();
				scheduleSettleProbe();
				return;
			}
			const delay = Math.min(STREAM_RETRY_BASE_MS * 2 ** attempt, STREAM_RETRY_MAX_MS);
			attempt += 1;
			source = null;
			current.close();
			retryTimer = setTimeout(() => {
				retryTimer = null;
				connect();
			}, delay);
		});
	};

	doc?.addEventListener('visibilitychange', onVisibility);
	// A document that starts hidden (a tab opened in the background) never
	// fires visibilitychange until first activation (MDN Page Visibility), so
	// it must not connect now — only the first 'visible' brings the stream.
	if (doc?.visibilityState === 'hidden') {
		suspended = true;
	} else {
		connect();
	}
	return stop;
}

/** Reading position → 5% bucket, clamped to the 20-cell histogram. */
export function positionBucket(percent: number): number {
	return Math.min(19, Math.max(0, Math.floor(percent / 5)));
}

/** Read progress through an element: 0 at first pixel, 100 once passed. */
export function elementProgress(
	rect: { top: number; height: number },
	viewportHeight: number
): number {
	if (rect.height <= 0) return 100;
	const read = viewportHeight - rect.top;
	return Math.min(100, Math.max(0, (read / rect.height) * 100));
}
