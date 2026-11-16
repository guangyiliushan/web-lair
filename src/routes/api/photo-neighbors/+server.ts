import { error, json } from '@sveltejs/kit';
import { getVisiblePhotoBySlug, listPhotoNeighbors } from '$lib/server/services/photos';
import { isPhotoSlug } from '$lib/utils/slug';
import type { RequestHandler } from './$types';

/**
 * Public JSON for the overlay viewer: the ±1 neighbours of a photo slug and the
 * 1-based feed position behind the "i / N" counter; the detail page ships the
 * same payload inline, so only lazy fetches past that window land here.
 * Visibility comes from the page's own loaders - an invisible or missing photo is
 * a plain 404, a non-slug 404s before the database is touched, and retired slugs
 * are not resolved through `slug_trackers` (stricter than the page's 301).
 * Symptom when dropped: hidden rows leak to slug guessers, or a cached body keeps
 * serving a photo the owner just hid - the decision is live, so never shared-cache.
 */
export const GET: RequestHandler = async ({ url }) => {
	const slug = (url.searchParams.get('slug') ?? '').trim();
	if (!slug) error(400, 'slug is required');
	if (!isPhotoSlug(slug)) error(404, 'Not found');
	const photo = await getVisiblePhotoBySlug(slug);
	if (!photo) error(404, 'Not found');
	const { newer, older, position } = await listPhotoNeighbors({
		sortAt: photo.takenAt ?? photo.createdAt,
		id: photo.id
	});
	return json(
		{ slug: photo.slug, newer, older, position },
		{ headers: { 'cache-control': 'private, max-age=0, must-revalidate' } }
	);
};
