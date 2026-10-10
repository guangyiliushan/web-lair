import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the public gallery feed (§5.1): the load is a
 * stateless cursor chain — stored `c` params only bound the page count, the
 * route re-fetches from page one and recomputes boundaries from the actual
 * rows; a malformed entry truncates the chain; filters are shape-validated
 * and echoed; the load-more href carries every SHOWN boundary.
 */
const { service } = vi.hoisted(() => ({
	service: {
		listPublicPhotos: vi.fn(),
		listPhotoFacets: vi.fn()
	}
}));

vi.mock('$lib/server/services/photos', () => ({
	listPublicPhotos: service.listPublicPhotos,
	listPhotoFacets: service.listPhotoFacets
}));

import { load } from './+page.server';

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function uuid(index: number): string {
	return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function item(id: string, sortAtIso: string) {
	return {
		id,
		slug: `photo-${id.slice(0, 4)}`,
		title: null,
		description: null,
		takenAt: new Date(sortAtIso),
		createdAt: new Date(sortAtIso),
		cameraMake: null,
		cameraModel: null,
		lensModel: null,
		latitude: null,
		longitude: null,
		objectKey: 'aa/x.jpg',
		fileName: 'x.jpg',
		mimeType: 'image/jpeg',
		width: 100,
		height: 100,
		thumbhash: null,
		palette: null
	};
}

const FACETS = { years: [2026], cameras: [], lenses: [], tags: [] };

function makeEvent(search = '') {
	return { url: new URL(`http://localhost/photos${search}`) } as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	service.listPhotoFacets.mockResolvedValue(FACETS);
});

describe('(site)/photos load — public gallery feed', () => {
	it('loads the first page with default filters and no load-more on a short page', async () => {
		service.listPublicPhotos.mockResolvedValueOnce([item(UUID_A, '2026-01-03T00:00:00.000Z')]);

		const data = (await load(makeEvent())) as {
			filters: Record<string, unknown>;
			feed: Promise<{ items: unknown[]; facets: unknown; moreHref: string | null }>;
		};

		expect(service.listPublicPhotos).toHaveBeenCalledWith({}, null, 24);
		const feed = await data.feed;
		expect(feed.items).toHaveLength(1);
		expect(feed.moreHref).toBeNull();
		expect(feed.facets).toEqual(FACETS);
		expect(data.filters).toEqual({ year: null, camera: null, lens: null, tag: null });
	});

	it('accumulates the chain and renders a load-more href with every shown boundary', async () => {
		const pageOne = Array.from({ length: 24 }, (_, index) =>
			item(index === 23 ? UUID_A : uuid(index), '2026-01-05T00:00:00.000Z')
		);
		const pageTwo = Array.from({ length: 24 }, (_, index) =>
			item(index === 23 ? UUID_B : uuid(100 + index), '2026-01-04T00:00:00.000Z')
		);
		service.listPublicPhotos.mockResolvedValueOnce(pageOne).mockResolvedValueOnce(pageTwo);

		const data = (await load(makeEvent(`?c=2026-01-06T00:00:00.000Z~${UUID_B}`))) as {
			feed: Promise<{ items: unknown[]; moreHref: string | null }>;
		};
		const feed = await data.feed;

		expect(service.listPublicPhotos).toHaveBeenCalledTimes(2);
		// The second call's cursor is recomputed from the fetched page one row,
		// not read from the URL entry (which only bounded the count).
		expect(service.listPublicPhotos.mock.calls[1]).toEqual([
			{},
			{ sortAt: '2026-01-05T00:00:00.000Z', id: UUID_A },
			24
		]);
		expect(feed.items).toHaveLength(48);
		const params = new URLSearchParams(feed.moreHref!.slice(1));
		expect(params.getAll('c')).toEqual([
			`2026-01-05T00:00:00.000Z~${UUID_A}`,
			`2026-01-04T00:00:00.000Z~${UUID_B}`
		]);
	});

	it('truncates the chain at the first malformed cursor entry', async () => {
		service.listPublicPhotos.mockResolvedValueOnce([]);

		const data = (await load(makeEvent(`?c=nonsense&c=2026-01-06T00:00:00.000Z~${UUID_B}`))) as {
			feed: Promise<unknown>;
		};
		await data.feed;

		expect(service.listPublicPhotos).toHaveBeenCalledTimes(1);
	});

	it('validates and echoes filters; bad years are dropped', async () => {
		service.listPublicPhotos.mockResolvedValueOnce([]);

		const data = (await load(makeEvent('?year=abcd&camera=X-T5&lens=XF+35&tag=tt'))) as {
			filters: Record<string, unknown>;
		};

		expect(service.listPublicPhotos).toHaveBeenCalledWith(
			{ cameraModel: 'X-T5', lensModel: 'XF 35', tagId: 'tt' },
			null,
			24
		);
		expect(data.filters).toEqual({ year: null, camera: 'X-T5', lens: 'XF 35', tag: 'tt' });
	});
});
