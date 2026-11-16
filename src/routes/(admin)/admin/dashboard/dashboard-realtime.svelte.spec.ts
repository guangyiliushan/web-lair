import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import AdminDashboard from './+page.svelte';

/**
 * Browser specs for the dashboard realtime cards (realtime R4, register E1):
 * SSR values render as given, "—" covers disabled/unavailable, the admin
 * stream upgrades the three metrics and stamps the updated-at label, and no
 * stream is opened when presence is off. EventSource is stubbed; the
 * engine's own timing/watchdog logic lives in presence-client.test.ts.
 */

overwriteGetLocale(() => 'en');

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
	emit(type: string, data: unknown) {
		const event = new MessageEvent(type, { data: JSON.stringify(data) });
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

function mount(
	presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null },
	extra: Record<string, unknown> = {}
) {
	return render(AdminDashboard, {
		data: {
			headerTitle: 'Dashboard',
			counts: { posts: 1, notes: 2, quotes: 3, thoughts: 4, moments: 5 },
			stats: {
				pages: 2,
				categories: 1,
				comments: 0,
				commentsUnread: 0,
				friends: 0,
				friendRequests: 0,
				characters: 1234,
				reads: 0,
				likes: 0
			},
			charts: { publish: [], categories: [], comments: [] },
			lastAdminLogin: null,
			siteTimezone: 'UTC',
			auth: null,
			presence,
			traffic: {
				available: true,
				pageRequests: 12,
				pageRequestsLowerBound: false,
				visitors: 3,
				notFound: 1
			},
			...extra
		} as never
	});
}

function metric(name: 'site' | 'day' | 'peak'): string | null | undefined {
	return document.querySelector(`[data-metric="${name}"]`)?.textContent;
}

describe('admin dashboard realtime cards', () => {
	beforeEach(() => {
		FakeEventSource.instances = [];
		vi.stubGlobal('EventSource', FakeEventSource);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('renders em-dashes and opens no stream when presence is disabled', async () => {
		await mount({ enabled: false, site: null, day: null, peak: null });
		expect(metric('site')).toBe('—');
		expect(metric('day')).toBe('—');
		expect(metric('peak')).toBe('—');
		expect(FakeEventSource.instances).toHaveLength(0);
	});

	it('renders the SSR values and upgrades them over the admin stream', async () => {
		await mount({ enabled: true, site: 3, day: 12, peak: 7 });
		expect(metric('site')).toBe('3');
		expect(metric('day')).toBe('12');
		expect(metric('peak')).toBe('7');
		expect(FakeEventSource.instances).toHaveLength(1);
		const url = new URL(FakeEventSource.instances[0].url, location.origin);
		expect(url.pathname).toBe('/api/presence/stream');
		expect(url.searchParams.get('c')).toBeNull();
		expect(document.querySelector('[data-slot="realtime-updated"]')).toBeNull();

		FakeEventSource.instances[0].emit('snapshot', { site: 4, day: 13, peak: 8 });
		await vi.waitFor(() => expect(metric('site')).toBe('4'));
		expect(metric('day')).toBe('13');
		expect(metric('peak')).toBe('8');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-slot="realtime-updated"]')).not.toBeNull()
		);
	});

	it('falls back to em-dashes when a snapshot carries nulls', async () => {
		await mount({ enabled: true, site: 3, day: 12, peak: 7 });
		FakeEventSource.instances[0].emit('snapshot', { site: null, day: null, peak: null });
		await vi.waitFor(() => expect(metric('site')).toBe('—'));
		expect(metric('day')).toBe('—');
		expect(metric('peak')).toBe('—');
	});

	it('renders the real statistics and none of the retired fake rows', async () => {
		await mount({ enabled: true, site: 1, day: 2, peak: 3 });
		expect(document.body.textContent).toContain('1,234');
		expect(document.body.textContent).not.toContain('API calls');
		expect(document.body.textContent).not.toContain('15,696,939');
	});

	it('renders the previous admin login trace', async () => {
		await mount(
			{ enabled: true, site: 1, day: 2, peak: 3 },
			{
				lastAdminLogin: {
					at: '2026-10-20T12:00:00.000Z',
					ip: '203.0.113.5',
					first: false
				}
			}
		);
		expect(document.body.textContent).toContain('Last admin login:');
		expect(document.body.textContent).toContain('203.0.113.5');
	});

	it('labels the current session as the first admin login', async () => {
		await mount(
			{ enabled: true, site: 1, day: 2, peak: 3 },
			{
				lastAdminLogin: {
					at: '2026-10-21T00:00:00.000Z',
					ip: null,
					first: true
				}
			}
		);
		expect(document.body.textContent).toContain('First admin login:');
		expect(document.body.textContent).toContain('—');
	});
});
