import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the public photo viewer (v1): visible rows render
 * with their filmstrip window; a retired slug resolves through slug_trackers
 * with exactly one 301 (query string preserved) and never redirects into a
 * hidden or missing target.
 */
const { service } = vi.hoisted(() => ({
	service: {
		getVisiblePhotoBySlug: vi.fn(),
		getVisiblePhotoById: vi.fn(),
		listPhotoStrip: vi.fn(),
		findSlugTargetId: vi.fn()
	}
}));

vi.mock('$lib/server/services/photos', () => ({
	getVisiblePhotoBySlug: service.getVisiblePhotoBySlug,
	getVisiblePhotoById: service.getVisiblePhotoById,
	listPhotoStrip: service.listPhotoStrip
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
	objectKey: 'aa/x.jpg',
	fileName: 'x.jpg',
	mimeType: 'image/jpeg',
	byteSize: 1,
	width: 100,
	height: 100,
	thumbhash: null,
	palette: null,
	tags: []
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
	service.listPhotoStrip.mockResolvedValue({
		strip: [PHOTO],
		position: { index: 1, total: 1 }
	});
});

describe('(photos)/photos/[slug] load — viewer', () => {
	it('serves a visible photo with its filmstrip window and position', async () => {
		service.getVisiblePhotoBySlug.mockResolvedValue(PHOTO);
		const newer = { slug: 'newer', title: null };
		const older = { slug: 'older', title: null };
		service.listPhotoStrip.mockResolvedValue({
			strip: [newer, PHOTO, older],
			position: { index: 2, total: 5 }
		});

		const data = (await load(makeEvent())) as {
			seo: { path: string };
			photo: { slug: string };
			strip: { slug: string }[];
			position: { index: number; total: number };
		};

		expect(data.seo).toEqual({ path: '/photos/sunset' });
		expect(data.photo.slug).toBe('sunset');
		expect(data.strip.map((photo) => photo.slug)).toEqual(['newer', 'sunset', 'older']);
		expect(service.listPhotoStrip).toHaveBeenCalledWith(
			{ sortAt: PHOTO.takenAt, id: PHOTO.id },
			PHOTO,
			12
		);
		expect(data.position).toEqual({ index: 2, total: 5 });
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
