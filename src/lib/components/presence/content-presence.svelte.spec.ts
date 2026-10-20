import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import ContentPresence from './content-presence.svelte';

/**
 * Browser specs for the reader presence widget (realtime R3): one stream per
 * widget keyed to the content id, badge/strip rendering from snapshots (with
 * en copy pinned), the 0/unavailable hiding rules, readerDots gating, the
 * readerView-off contract (no stream, heartbeats still flow) and the
 * heartbeat wire shape. EventSource and fetch are stubbed; the engine's own
 * timing logic is covered in presence-client.test.ts.
 */

// Pin the locale for copy assertions (official paraglide escape hatch,
// mirrors comment-threads.svelte.spec.ts).
overwriteGetLocale(() => 'en');

const CONTENT = '0d9e4b2a-7c31-4f5e-8a6b-1c2d3e4f5a6b';

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readyState = 0;
	readonly url: string;
	#listeners = new Map<string, ((event: Event) => void)[]>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, listener: (event: Event) => void) {
		const list = this.#listeners.get(type) ?? [];
		list.push(listener);
		this.#listeners.set(type, list);
	}
	close() {
		this.readyState = 2;
	}
	emit(type: string, data?: unknown) {
		const event =
			data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

function histogram(...entries: [number, number][]): number[] {
	const hist = new Array<number>(20).fill(0);
	for (const [index, count] of entries) hist[index] = count;
	return hist;
}

function badge(): Element | null {
	return document.querySelector('[data-slot="presence-badge"]');
}

function countText(): string | null | undefined {
	return document.querySelector('[data-slot="presence-count"]')?.textContent;
}

let fetchMock: ReturnType<typeof vi.fn>;

describe('content presence widget', () => {
	beforeEach(() => {
		FakeEventSource.instances = [];
		vi.stubGlobal('EventSource', FakeEventSource);
		fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);
		sessionStorage.clear();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('stays fully inert when presence is disabled (no stream, no beats, no UI)', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: false, readerView: true, readerDots: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(FakeEventSource.instances).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(badge()).toBeNull();
		expect(document.querySelector('[data-slot="presence-strip"]')).toBeNull();
	});

	it('opens exactly one stream for the content id and hides until data arrives', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: false }
		});
		expect(FakeEventSource.instances).toHaveLength(1);
		const url = new URL(FakeEventSource.instances[0].url, location.origin);
		expect(url.pathname).toBe('/api/presence/stream');
		expect(url.searchParams.get('c')).toBe(CONTENT);
		expect(badge()).toBeNull();
	});

	it('renders the badge and the density strip from snapshots (plural + singular)', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: false }
		});
		const source = FakeEventSource.instances[0];
		source.emit('snapshot', { content: { count: 2, hist: histogram([3, 1]) } });
		await vi.waitFor(() => expect(badge()).not.toBeNull());
		expect(countText()).toBe('2 people are reading');
		const strip = document.querySelector('[data-slot="presence-strip"]');
		expect(strip).not.toBeNull();
		expect(strip?.getAttribute('aria-hidden')).toBe('true');
		expect(strip?.getAttribute('title')).toBe('Reading position distribution');
		expect(document.querySelector('.sr-only')?.textContent).toBe('Reading position distribution');
		source.emit('snapshot', { content: { count: 1, hist: histogram([3, 1]) } });
		await vi.waitFor(() => expect(countText()).toBe('1 person is reading'));
	});

	it('renders the badge without the decorative strip when the caller opts out', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: true },
			strip: false
		});
		const source = FakeEventSource.instances[0];
		source.emit('snapshot', { content: { count: 2, hist: histogram([3, 1]) }, dots: [4] });
		await vi.waitFor(() => expect(badge()).not.toBeNull());
		expect(document.querySelector('[data-slot="presence-strip"]')).toBeNull();
		expect(document.querySelector('[data-presence-dot]')).toBeNull();
	});

	it('hides at zero, recovers, then hides again on a degraded snapshot', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: false }
		});
		const source = FakeEventSource.instances[0];
		source.emit('snapshot', { content: { count: 1, hist: histogram([1, 1]) } });
		await vi.waitFor(() => expect(badge()).not.toBeNull());
		source.emit('snapshot', { content: { count: 0, hist: histogram() } });
		await vi.waitFor(() => expect(badge()).toBeNull());
		source.emit('snapshot', { content: { count: 3, hist: histogram([2, 3]) } });
		await vi.waitFor(() => expect(badge()).not.toBeNull());
		source.emit('snapshot', { content: null });
		await vi.waitFor(() => expect(badge()).toBeNull());
	});

	it('renders nothing with readerView off, still heartbeats, opens no stream', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: false, readerDots: false }
		});
		expect(FakeEventSource.instances).toHaveLength(0);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/presence/heartbeat');
		const body = JSON.parse(String(init.body)) as { token: string; c: string };
		expect(body.c).toBe(CONTENT);
		expect(body.token).toBe(sessionStorage.getItem('wl.presence.token'));
		expect(badge()).toBeNull();
	});

	it('shows the dots without the badge when only readerDots is on (admin view)', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: false, readerDots: true }
		});
		expect(FakeEventSource.instances).toHaveLength(1);
		const source = FakeEventSource.instances[0];
		source.emit('snapshot', {
			content: { count: 2, hist: histogram([3, 1]) },
			dots: [3, 11]
		});
		await vi.waitFor(() =>
			expect(document.querySelectorAll('[data-presence-dot]')).toHaveLength(2)
		);
		expect(badge()).toBeNull();
		expect(document.querySelector('[data-slot="presence-strip"]')).not.toBeNull();
	});

	it('draws anonymous dots only when readerDots is on', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: true }
		});
		const source = FakeEventSource.instances[0];
		source.emit('snapshot', {
			content: { count: 3, hist: histogram([3, 3]) },
			dots: [3, 3, 11]
		});
		await vi.waitFor(() => expect(document.querySelectorAll('[data-presence-dot]').length).toBe(3));
	});

	it('leaves the strip dot-free with readerDots off', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: false }
		});
		const source = FakeEventSource.instances[0];
		source.emit('snapshot', { content: { count: 1, hist: histogram([3, 1]) }, dots: [3] });
		await vi.waitFor(() => expect(badge()).not.toBeNull());
		expect(document.querySelectorAll('[data-presence-dot]')).toHaveLength(0);
	});

	it('sends beats with the json contract, the uuid token and the bucket', async () => {
		await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: false }
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/presence/heartbeat');
		expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
		const body = JSON.parse(String(init.body)) as { token: string; c: string; bucket: number };
		expect(body.c).toBe(CONTENT);
		expect(body.token).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.bucket).toBeTypeOf('number');
	});
});

describe('position early reporting (D2)', () => {
	const mountedFns: Array<() => void> = [];
	let fetchMock: ReturnType<typeof vi.fn>;
	let nowMs = 0;

	async function nextFrames(): Promise<void> {
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}

	async function mountInArticle() {
		const article = document.createElement('article');
		const host = document.createElement('div');
		article.appendChild(host);
		document.body.appendChild(article);
		let rectTop = 900; // 10% through a 1000px article in a 1000px viewport
		article.getBoundingClientRect = () =>
			({
				top: rectTop,
				height: 1000,
				left: 0,
				right: 0,
				bottom: rectTop + 1000,
				width: 0,
				x: 0,
				y: rectTop,
				toJSON: () => ({})
			}) as DOMRect;
		const instance = mount(ContentPresence, {
			target: host,
			props: { contentId: CONTENT, config: { enabled: true, readerView: true, readerDots: false } }
		});
		mountedFns.push(() => {
			unmount(instance);
			article.remove();
		});
		return { setTop: (value: number) => void (rectTop = value) };
	}

	let previousInnerHeight = 0;

	beforeEach(() => {
		mountedFns.length = 0;
		FakeEventSource.instances = [];
		fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);
		vi.stubGlobal('EventSource', FakeEventSource);
		sessionStorage.clear();
		nowMs = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
		previousInnerHeight = window.innerHeight;
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
	});
	afterEach(() => {
		while (mountedFns.length > 0) mountedFns.pop()!();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		Object.defineProperty(window, 'innerHeight', {
			configurable: true,
			value: previousInnerHeight
		});
	});

	it('reports early only past the 5s floor AND on a ≥2% move (boundaries pinned)', async () => {
		const { setTop } = await mountInArticle();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // immediate beat

		nowMs = 6_000; // floor satisfied (lastReportedAt starts at 0)
		setTop(900); // 10%
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		nowMs = 11_000; // floor exactly 5000ms …
		setTop(880); // … and exactly +2.0%: both boundaries report
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(3);

		nowMs = 16_000; // floor met again …
		setTop(861); // … but +1.9%: below the delta boundary, silent
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(3);

		nowMs = 21_000;
		setTop(800); // 20% — a genuine move reports
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(4);

		nowMs = 21_500; // inside the 5s floor: a big move stays silent
		setTop(600); // 40%
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(4);

		nowMs = 26_000; // floor exactly 5000ms again: +4% reports
		setTop(760); // 24%
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(5);

		nowMs = 30_999; // floor short by 1ms (4999 since the 26000 report)
		setTop(400); // 60%
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(5);

		nowMs = 31_000; // floor exactly 5000ms: the same move reports now
		setTop(380); // 62%
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(6);

		nowMs = 36_000; // floor exactly 5000ms; a ≥2% ROLLBACK reports too
		setTop(900); // 10% — |10 − 62| = 52
		window.dispatchEvent(new Event('scroll'));
		await nextFrames();
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});

	it('releases the stream and listeners on unmount (cleanup teeth)', async () => {
		const { unmount } = await render(ContentPresence, {
			contentId: CONTENT,
			config: { enabled: true, readerView: true, readerDots: false }
		});
		await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
		const source = FakeEventSource.instances[0];
		const callsBefore = fetchMock.mock.calls.length;
		await unmount();
		// stopStream ran: the EventSource is closed (deleting the cleanup line
		// would leave readyState at its initial 0 and turn this red).
		expect(source.readyState).toBe(2);
		// The scroll listener is gone: a big move cannot produce a report.
		window.dispatchEvent(new Event('scroll'));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(fetchMock.mock.calls.length).toBe(callsBefore);
	});

	it('coalesces same-frame scrolls into one rAF (throttle guard)', async () => {
		const nativeRaf = requestAnimationFrame.bind(globalThis);
		const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
		const { setTop } = await mountInArticle();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		rafSpy.mockClear();
		nowMs = 6_000;
		setTop(700); // 30% — a big move: one coalesced frame, one report
		window.dispatchEvent(new Event('scroll'));
		window.dispatchEvent(new Event('scroll'));
		// Two NATIVE frames (unspied) flush the single scheduled callback —
		// deterministic, unlike a wall-clock sleep.
		await new Promise((resolve) => nativeRaf(() => nativeRaf(resolve)));
		expect(rafSpy).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
