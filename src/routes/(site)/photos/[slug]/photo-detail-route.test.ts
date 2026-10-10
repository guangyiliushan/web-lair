import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the public photo viewer (v1): visible rows render
 * with their neighbours; a retired slug resolves through slug_trackers with
 * exactly one 301 (query string preserved) and never redirects into a
 * hidden or missing target.
 */
const { service } = vi.hoisted(() => ({
	service: {
		getVisiblePhotoBySlug: vi.fn(),
		getVisiblePhotoById: vi.fn(),
		listPhotoNeighbors: vi.fn(),
		findSlugTargetId: vi.fn()
	}
}));

vi.mock('$lib/server/services/photos', () => ({
	getVisiblePhotoBySlug: service.getVisiblePhotoBySlug,
	getVisiblePhotoById: service.getVisiblePhotoById,
	listPhotoNeighbors: service.listPhotoNeighbors
}));
vi.mock('$lib/server/services/slug-resolver', () => ({
	findSlugTargetId: service.findSlugTargetId
}));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	localizeHref: (href: string) => href,
	locales: ['en', 'zh-cn', 'ja']
}));

import { load } from './+page.server';

const PHOTO = {
	id: '11111111-1111-4111-8111-111111111111',
	slug: 'sunset',
	title: null,
	description: null,
	takenAt: new Date('2026-01-02T00:00:00Z'),
	createdAt: new Date('2026-01-01T00:00:00Z'),
	cameraMake: 'FUJIFILM',
	cameraModel: 'X-T5',
	lensModel: null,
	fNumber: null,
	focalLengthMm: null,
	exposureTimeS: null,
	iso: null,
	latitude: null,
	longitude: null,
	altitudeM: null,
	exif: null,
	objectKey: 'aa/x.jpg',
	fileName: 'x.jpg',
	mimeType: 'image/jpeg',
	byteSize: 1,
	width: 100,
	height: 100,
	thumbhash: null,
	palette: null
};

function makeEvent(slug = 'sunset', search = '') {
	return {
		params: { slug },
		url: new URL(`http://localhost/en/photos/${slug}${search}`)
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	service.findSlugTargetId.mockResolvedValue(null);
	service.listPhotoNeighbors.mockResolvedValue({ newer: null, older: null });
});

describe('(site)/photos/[slug] load — viewer', () => {
	it('serves a visible photo with neighbours, ordered by the feed tuple', async () => {
		service.getVisiblePhotoBySlug.mockResolvedValue(PHOTO);
		service.listPhotoNeighbors.mockResolvedValue({
			newer: { slug: 'newer', title: null },
			older: { slug: 'older', title: null }
		});

		const data = (await load(makeEvent())) as {
			seo: { path: string };
			photo: { slug: string };
			neighbors: { newer: { slug: string } | null; older: { slug: string } | null };
		};

		expect(data.seo).toEqual({ path: '/photos/sunset' });
		expect(data.photo.slug).toBe('sunset');
		expect(data.neighbors.newer?.slug).toBe('newer');
		expect(data.neighbors.older?.slug).toBe('older');
		expect(service.listPhotoNeighbors).toHaveBeenCalledWith({
			sortAt: PHOTO.takenAt,
			id: PHOTO.id
		});
	});

	it('redirects a retired slug once, preserving the query string', async () => {
		service.getVisiblePhotoBySlug.mockResolvedValue(null);
		service.findSlugTargetId.mockResolvedValue('22222222-2222-4222-8222-222222222222');
		service.getVisiblePhotoById.mockResolvedValue({ ...PHOTO, slug: 'sunset-2' });

		await expect(load(makeEvent('sunset', '?ref=x'))).rejects.toMatchObject({
			status: 301,
			location: '/photos/sunset-2?ref=x'
		});
	});

	it('404s when the tracked target is hidden or gone', async () => {
		service.getVisiblePhotoBySlug.mockResolvedValue(null);
		service.findSlugTargetId.mockResolvedValue('22222222-2222-4222-8222-222222222222');
		service.getVisiblePhotoById.mockResolvedValue(null);

		await expect(load(makeEvent())).rejects.toMatchObject({ status: 404 });
	});

	it('404s without a tracker entry', async () => {
		service.getVisiblePhotoBySlug.mockResolvedValue(null);

		await expect(load(makeEvent())).rejects.toMatchObject({ status: 404 });
	});
});
