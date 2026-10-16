import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
		source.emit('snapshot', { content: { count: 1, hist: histogram([3, 1]) } });
		await vi.waitFor(() => expect(countText()).toBe('1 person is reading'));
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
