import type { RequestHandler } from './$types';
import { getOption } from '$lib/server/config/options-registry';
import { effectiveReaderDots } from '$lib/server/services/presence';
import { isUuid } from '$lib/utils/uuid';
import { PRESENCE_KEEPALIVE_TICKS, PRESENCE_SNAPSHOT_MS, snapshotFor } from './snapshot';

/**
 * Presence SSE stream (realtime batch R2, ledger §23 / plan §B): one
 * `text/event-stream` per tab — a snapshot every 5s plus a 15s comment
 * keepalive — feeding the reader badge / density strip and the admin
 * dashboard. Hand-rolled streaming Response; the SvelteKit routing docs name
 * server-sent events as the canonical `ReadableStream` use case.
 *
 * Status discipline (WHATWG §9.2): while streaming the response is ALWAYS
 * 200 — the spec makes any non-200 (or non-`text/event-stream`) a permanent
 * failure the browser never retries, so a dead cache degrades fields to null
 * inside the payload instead. The only deliberate non-200s are the 204s and
 * the two pre-stream rejects: `presence.enabled === false` → 204 (the
 * spec's stop-reconnecting signal) and HEAD → 204 (a bodyless probe must not
 * spin up a stream; kit 2.70 runs GET for HEAD unless a HEAD export exists).
 *
 * Scoping (register R-5/R-6): `?c=<uuid>` streams the content slice for
 * readers; the anonymous position dots go to admins always and to readers
 * only when `presence.readerDots` is on (default off) — a connect-time
 * option read, never per tick. Without `c` the stream is admin-only
 * (site/day/peak for the dashboard) — site-wide numbers are never public,
 * and a reader asking for them gets a 400. `locals.admin` comes from the
 * hooks (single source for the role check); bodies never leave the server
 * (dots are bucket indices, not tokens).
 */

export const prerender = false;

/** A bodyless probe must not open a stream (kit runs GET for HEAD otherwise). */
export const HEAD: RequestHandler = () =>
	new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

export const GET: RequestHandler = async ({ url, request, locals }) => {
	let enabled = true;
	try {
		enabled = await getOption('presence.enabled');
	} catch {
		// fail-open: an options read failure must not kill the stream
	}
	if (!enabled) return new Response(null, { status: 204 });

	const candidate = url.searchParams.get('c');
	if (candidate !== null && !isUuid(candidate)) return new Response(null, { status: 400 });
	const admin = Boolean(locals.admin);
	// Readers always stream a content slice; a no-`c` reader request is a
	// caller bug (site numbers are admin-only), not an empty stream.
	if (candidate === null && !admin) return new Response(null, { status: 400 });

	// Dots ride the admin view always; readers receive them only when the
	// site turned `presence.readerDots` on (register F1/R-4). Connect-time
	// read: one settings lookup per connection, never per tick.
	let dots = admin;
	if (!dots) {
		let readerDotsOption = false;
		try {
			readerDotsOption = await getOption('presence.readerDots');
		} catch {
			// fail-open: no dots on a settings read failure
		}
		dots = effectiveReaderDots(readerDotsOption, admin);
	}

	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setInterval> | null = null;
	let finished = false;
	let pumping = false;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const stop = () => {
				if (finished) return;
				finished = true;
				if (timer !== null) clearInterval(timer);
				timer = null;
				try {
					controller.close();
				} catch {
					// the runtime already errored the stream (client vanished)
				}
			};
			const write = (chunk: string): boolean => {
				if (finished) return false;
				try {
					controller.enqueue(encoder.encode(chunk));
					return true;
				} catch {
					return false;
				}
			};
			// One pump at a time: a slow read must not let a later tick's
			// snapshot overtake it (and reconnects cannot stack timers).
			const pump = async (): Promise<void> => {
				if (finished || pumping) return;
				pumping = true;
				try {
					const snapshot = await snapshotFor(candidate, { admin, dots });
					if (!finished && !write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)) {
						stop();
					}
				} catch {
					// Defense layer, currently unreachable: the service swallows
					// its own construction/store failures, so snapshotFor only
					// rejects if a future change adds a bare await here. If it
					// ever does, degrade THIS frame and keep the stream at 200
					// — a 5xx-class failure would kill SSE for good (WHATWG
					// §9.2 never retries a non-200).
					if (!finished) {
						const degraded =
							candidate !== null ? { content: null } : { site: null, day: null, peak: null };
						if (!write(`event: snapshot\ndata: ${JSON.stringify(degraded)}\n\n`)) stop();
					}
				} finally {
					pumping = false;
				}
			};

			// Explicit reconnect delay (the spec default is UA-defined), then
			// the first frame immediately — no waiting for the first tick.
			write('retry: 5000\n\n');
			void pump();

			let tick = 0;
			timer = setInterval(() => {
				tick += 1;
				// Lone comment line: ignored by parsers, defeats idle proxies.
				if (tick % PRESENCE_KEEPALIVE_TICKS === 0) write(': keepalive\n\n');
				void pump();
			}, PRESENCE_SNAPSHOT_MS);

			// Fallback teardown only: kit's node layer disposes the response
			// body via reader.cancel() (the primary path); a GET body is
			// already complete, so the request signal rarely fires here.
			request.signal.addEventListener('abort', stop, { once: true });
		},
		cancel() {
			// Kit tears the stream down when the response is disposed; the
			// tick timer must not outlive the connection either way.
			if (finished) return;
			finished = true;
			if (timer !== null) clearInterval(timer);
			timer = null;
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			'x-accel-buffering': 'no'
		}
	});
};
