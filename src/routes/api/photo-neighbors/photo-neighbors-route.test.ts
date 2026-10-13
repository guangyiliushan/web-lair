import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * (api)/photo-neighbors - the overlay viewer's lazy cycling source (3c).
 * The service loaders keep the visibility contract; this test pins the
 * endpoint surface: input guard, 404 pass-through and the JSON shape.
 */
const { service } = vi.hoisted(() => ({
	service: {
		getVisiblePhotoBySlug: vi.fn(),
		listPhotoNeighbors: vi.fn()
	}
}));

vi.mock('$lib/server/services/photos', () => ({
	getVisiblePhotoBySlug: service.getVisiblePhotoBySlug,
	listPhotoNeighbors: service.listPhotoNeighbors
}));

import { GET } from './+server';

const PHOTO = {
	id: '11111111-1111-1111-1111-111111111111',
	slug: 'sunset',
	takenAt: new Date('2026-01-01T00:00:00Z'),
	createdAt: new Date('2026-01-02T00:00:00Z')
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/photo-neighbors', () => {
	it('rejects a missing slug with 400', async () => {
		await expect(
			GET({ url: new URL('http://localhost/api/photo-neighbors') } as never)
		).rejects.toMatchObject({ status: 400 });
		expect(service.getVisiblePhotoBySlug).not.toHaveBeenCalled();
	});

	it('answers 404 for a missing or invisible photo', async () => {
		service.getVisiblePhotoBySlug.mockResolvedValue(null);
		await expect(
			GET({ url: new URL('http://localhost/api/photo-neighbors?slug=ghost') } as never)
		).rejects.toMatchObject({ status: 404 });
		expect(service.listPhotoNeighbors).not.toHaveBeenCalled();
	});

	it('returns the photo, its neighbours and the feed position', async () => {
		service.getVisiblePhotoBySlug.mockResolvedValue(PHOTO);
		service.listPhotoNeighbors.mockResolvedValue({
			newer: { slug: 'newer' },
			older: null,
			position: { index: 2, total: 7 }
		});

		const response = await GET({
			url: new URL('http://localhost/api/photo-neighbors?slug=sunset')
		} as never);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.photo).toMatchObject({ slug: 'sunset' });
		expect(payload.newer).toEqual({ slug: 'newer' });
		expect(payload.older).toBeNull();
		expect(payload.position).toEqual({ index: 2, total: 7 });
		// The cursor mirrors the detail loader: taken_at wins over created_at.
		expect(service.listPhotoNeighbors).toHaveBeenCalledWith({
			sortAt: PHOTO.takenAt,
			id: PHOTO.id
		});
	});
});
