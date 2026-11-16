import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the public gallery feed: the load is a stateless cursor
 * chain - stored `c` params only bound the page count, the route re-fetches from
 * page one and recomputes boundaries from the actual rows; a malformed entry
 * truncates the chain; filters are shape-validated and echoed as repeated URL
 * keys.
 */
const { service } = vi.hoisted(() => ({
	service: {
		listPublicPhotos: vi.fn(),
		listPhotoFacets: vi.fn(),
		countPublicPhotos: vi.fn()
	}
}));

vi.mock('$lib/server/services/photos', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/services/photos')>()),
	listPublicPhotos: service.listPublicPhotos,
	listPhotoFacets: service.listPhotoFacets,
	countPublicPhotos: service.countPublicPhotos
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
		fNumber: null,
		focalLengthMm: null,
		exposureTimeS: null,
		iso: null,
		latitude: null,
		longitude: null,
		objectKey: 'aa/x.jpg',
		fileName: 'x.jpg',
		mimeType: 'image/jpeg',
		byteSize: 91,
		width: 100,
		height: 100,
		thumbhash: null,
		palette: null
	};
}

const FACETS = {
	years: [2026],
	cameras: [],
	lenses: [],
	tags: [],
	counts: { years: { '2026': 1 }, cameras: {}, lenses: {}, tags: {} }
};

function makeEvent(search = '') {
	return { url: new URL(`http://localhost/photos${search}`) } as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	service.listPhotoFacets.mockResolvedValue(FACETS);
	service.countPublicPhotos.mockResolvedValue(1);
});

describe('(photos)/photos load — public gallery feed', () => {
	it('loads the first page with default filters and no load-more on a short page', async () => {
		service.listPublicPhotos.mockResolvedValueOnce([item(UUID_A, '2026-01-03T00:00:00.000Z')]);

		const data = (await load(makeEvent())) as {
			query: Record<string, unknown>;
			feed: Promise<{ items: unknown[]; facets: unknown; total: number; moreHref: string | null }>;
		};

		expect(service.listPublicPhotos).toHaveBeenCalledWith({}, null, 24);
		expect(service.countPublicPhotos).toHaveBeenCalledWith({});
		const feed = await data.feed;
		expect(feed.items).toHaveLength(1);
		expect(feed.total).toBe(1);
		expect(feed.moreHref).toBeNull();
		expect(feed.facets).toEqual(FACETS);
		expect(data.query).toEqual({
			years: [],
			cameras: [],
			lenses: [],
			tagIds: [],
			tagMode: 'any',
			q: '',
			columns: 'auto'
		});
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

	it('validates repeated filters and preserves them in the load-more href', async () => {
		const page = Array.from({ length: 24 }, (_, index) =>
			item(index === 23 ? UUID_A : uuid(index), '2026-01-05T00:00:00.000Z')
		);
		service.listPublicPhotos.mockResolvedValueOnce(page);

		const search = `?year=2024&year=2025&camera=X-T5&camera=X100&lens=XF+35&tag=${UUID_A}&tag=${UUID_B}&tagMode=all&q=sunset&cols=3`;
		const data = (await load(makeEvent(search))) as {
			query: Record<string, unknown>;
			feed: Promise<{ moreHref: string | null }>;
		};

		expect(service.listPublicPhotos).toHaveBeenCalledWith(
			{
				years: [2024, 2025],
				cameraModels: ['X-T5', 'X100'],
				lensModels: ['XF 35'],
				tagIds: [UUID_A, UUID_B],
				tagMode: 'all',
				query: 'sunset'
			},
			null,
			24
		);
		expect(data.query).toEqual({
			years: [2024, 2025],
			cameras: ['X-T5', 'X100'],
			lenses: ['XF 35'],
			tagIds: [UUID_A, UUID_B],
			tagMode: 'all',
			q: 'sunset',
			columns: '3'
		});

		const feed = await data.feed;
		const params = new URLSearchParams(feed.moreHref!.slice(1));
		expect(params.getAll('year')).toEqual(['2024', '2025']);
		expect(params.getAll('camera')).toEqual(['X-T5', 'X100']);
		expect(params.getAll('lens')).toEqual(['XF 35']);
		expect(params.getAll('tag')).toEqual([UUID_A, UUID_B]);
		expect(params.get('tagMode')).toBe('all');
		expect(params.get('q')).toBe('sunset');
		expect(params.get('cols')).toBe('3');
		expect(params.getAll('c')).toHaveLength(1);
	});

	it('drops malformed years, tags, columns and tag modes', async () => {
		service.listPublicPhotos.mockResolvedValueOnce([]);

		const data = (await load(makeEvent('?year=abcd&tag=not-a-uuid&cols=9&tagMode=bogus'))) as {
			query: Record<string, unknown>;
		};

		expect(service.listPublicPhotos).toHaveBeenCalledWith({}, null, 24);
		expect(data.query).toEqual({
			years: [],
			cameras: [],
			lenses: [],
			tagIds: [],
			tagMode: 'any',
			q: '',
			columns: 'auto'
		});
	});

	it('caps the cursor chain at 13 pages even with 13 valid cursors', async () => {
		const page = Array.from({ length: 24 }, (_, index) =>
			item(index === 23 ? UUID_A : uuid(index), '2026-01-05T00:00:00.000Z')
		);
		service.listPublicPhotos.mockResolvedValue(page);
		const cursors = Array.from({ length: 13 }, () => `c=2026-01-06T00:00:00.000Z~${UUID_B}`).join(
			'&'
		);
		const data = (await load(makeEvent(`?${cursors}`))) as { feed: Promise<unknown> };
		await data.feed;
		expect(service.listPublicPhotos).toHaveBeenCalledTimes(13);
	});

	it('fuzzes item coordinates to two decimals', async () => {
		service.listPublicPhotos.mockResolvedValueOnce([
			{
				...item(UUID_A, '2026-01-03T00:00:00.000Z'),
				latitude: '25.033123',
				longitude: '121.565432'
			}
		]);
		const data = (await load(makeEvent())) as {
			feed: Promise<{ items: { latitude: string | null; longitude: string | null }[] }>;
		};
		const feed = await data.feed;
		expect(feed.items[0]!.latitude).toBe('25.03');
		expect(feed.items[0]!.longitude).toBe('121.57');
	});
});
