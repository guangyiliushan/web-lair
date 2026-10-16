import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PresenceHeartbeat from './presence-heartbeat.svelte';

/**
 * Browser specs for the site heartbeat mount (realtime R3 wiring; review
 * finding P1): the component previously had NO test surface at all — its
 * mount line in the (site) layout could be deleted, or the R-6 exclusion
 * filter dropped, with every gate still green. $app/state is mocked (the
 * projects-grid precedent) with a mutable pathname.
 */
const { pageState } = vi.hoisted(() => ({
	pageState: { pathname: '/' }
}));

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL(`http://localhost:4173${pageState.pathname}`);
		},
		get data() {
			return {};
		}
	}
}));

let fetchMock: ReturnType<typeof vi.fn>;

describe('presence heartbeat mount', () => {
	beforeEach(() => {
		pageState.pathname = '/';
		fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);
		sessionStorage.clear();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('beats on a public surface with the token-only site body', async () => {
		await render(PresenceHeartbeat, { enabled: true });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/presence/heartbeat');
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		// Site beats carry no content fields (register D2): token only.
		expect(Object.keys(body)).toEqual(['token']);
		expect(body.token).toBe(sessionStorage.getItem('wl.presence.token'));
	});

	it('stays silent while disabled', async () => {
		await render(PresenceHeartbeat, { enabled: false });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(['/login', '/zh-cn/account', '/ja/verify-email', '/en/register'])(
		'never beats on the excluded surface %s',
		async (pathname) => {
			pageState.pathname = pathname;
			await render(PresenceHeartbeat, { enabled: true });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(fetchMock).not.toHaveBeenCalled();
		}
	);
});
