import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	fetch: vi.fn(),
	requireAdminRole: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({
	env: { SENTINEL_URL: 'http://sentinel:8888', SENTINEL_TOKEN: 'test-token' }
}));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: state.requireAdminRole }));
vi.stubGlobal('fetch', state.fetch);

import { clearSentinelCache } from '$lib/server/analytics/sentinel';
import { load } from './+page.server';

const FIXTURE = JSON.parse(
	readFileSync(
		new URL('../../../../lib/server/analytics/fixtures/traffic-dashboard.json', import.meta.url),
		'utf8'
	)
) as unknown;

function analyticsEvent(search = ''): never {
	return { url: new URL(`https://lair.example/admin/analytics${search}`) } as never;
}

interface LoadedData {
	range: '24h' | '7d' | '30d';
	generatedAt: string | null;
	traffic: {
		summary: {
			pageRequests: number;
			notFoundRequests: number;
			topErrorPaths: Array<{ path: string }>;
			pathsTruncated: boolean;
		};
		overview: { requests: number; uniqueVisitors: number };
		series: unknown[];
	} | null;
}

async function loadData(search = ''): Promise<LoadedData> {
	// PageServerLoad's generated type includes `void` for endpoints that return
	// nothing; this one always returns the object above.
	return (await load(analyticsEvent(search))) as LoadedData;
}

beforeEach(() => {
	clearSentinelCache();
	state.fetch.mockReset();
	state.requireAdminRole.mockReset();
	state.requireAdminRole.mockResolvedValue(undefined);
});

describe('admin analytics load (P6)', () => {
	it('renders filtered page requests from the Sentinel dashboard', async () => {
		state.fetch.mockResolvedValue(
			new Response(JSON.stringify(FIXTURE), {
				headers: { 'content-type': 'application/json' }
			})
		);

		const data = await loadData('?range=7d');

		expect(state.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.range).toBe('7d');
		expect(data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Math.abs(Date.now() - new Date(data.generatedAt!).getTime())).toBeLessThan(5_000);
		expect(data.traffic).not.toBeNull();
		// 11 raw requests minus /_app/, /i/, /api/, style.css and feed.xml.
		expect(data.traffic?.summary.pageRequests).toBe(6);
		expect(data.traffic?.summary.notFoundRequests).toBe(2);
		expect(data.traffic?.summary.topErrorPaths.map((row) => row.path)).toEqual([
			'/posts/missing-page'
		]);
		expect(data.traffic?.overview.requests).toBe(11);
		expect(data.traffic?.overview.uniqueVisitors).toBe(8);
		expect(data.traffic?.series).toHaveLength(24);
		expect(data.traffic?.summary.pathsTruncated).toBe(false);
	});

	it('fails open to null traffic when Sentinel is unreachable', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		state.fetch.mockRejectedValue(new Error('connect ECONNREFUSED'));

		const data = await loadData('');

		expect(data.range).toBe('24h');
		expect(data.traffic).toBeNull();
		expect(data.generatedAt).toBeNull();
		expect(warn).toHaveBeenCalled();
	});

	it('falls back to 24h for an unknown range value', async () => {
		state.fetch.mockResolvedValue(new Response(JSON.stringify(FIXTURE)));
		const data = await loadData('?range=90d');
		expect(data.range).toBe('24h');
	});
});
