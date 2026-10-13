import { error, json } from '@sveltejs/kit';
import { getVisiblePhotoBySlug, listPhotoNeighbors } from '$lib/server/services/photos';
import type { RequestHandler } from './$types';

/**
 * Public JSON for the overlay viewer (3c): given a photo slug, return the
 * current photo, its ±1 neighbours (viewer field set) and the 1-based feed
 * position used by the「i / N」counter. The detail page ships the same
 * payload inline; this endpoint serves the lazy fetches when the overlay
 * walks past the ±1 window (Q13: ←→ neighbours, URL kept in sync via
 * history.replaceState).
 *
 * Visibility is enforced by the same service loaders the page uses: an
 * invisible or missing photo is a plain 404 - never a JSON peek into
 * hidden content.
 */
export const GET: RequestHandler = async ({ url }) => {
	const slug = (url.searchParams.get('slug') ?? '').trim();
	if (!slug) error(400, 'slug is required');
	const photo = await getVisiblePhotoBySlug(slug);
	if (!photo) error(404, 'Not found');
	const { newer, older, position } = await listPhotoNeighbors({
		sortAt: photo.takenAt ?? photo.createdAt,
		id: photo.id
	});
	return json({ photo, newer, older, position });
};
