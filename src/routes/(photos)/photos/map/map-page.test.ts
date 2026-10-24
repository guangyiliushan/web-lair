import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the public map load (review round 1): located rows
 * only, coordinates fuzzed to two decimals at the public boundary, and
 * unparseable rows filtered out.
 */
const { service } = vi.hoisted(() => ({ service: { listPublicPhotos: vi.fn() } }));

vi.mock('$lib/server/services/photos', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/services/photos')>()),
	listPublicPhotos: service.listPublicPhotos
}));

import { load } from './+page.server';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('(site)/photos/map load', () => {
	it('asks for located photos only and fuzzes coordinates to two decimals', async () => {
		service.listPublicPhotos.mockResolvedValueOnce([
			{ slug: 'a', title: { en: 'A' }, latitude: '25.033123', longitude: '121.565432' },
			{ slug: 'broken', title: null, latitude: 'x', longitude: null }
		]);

		const data = (await load({} as never)) as {
			photos: { slug: string; latitude: number; longitude: number }[];
		};

		expect(service.listPublicPhotos).toHaveBeenCalledWith({ hasLocation: true }, null, 200);
		expect(data.photos).toEqual([
			{ slug: 'a', title: { en: 'A' }, latitude: 25.03, longitude: 121.57 }
		]);
	});
});
