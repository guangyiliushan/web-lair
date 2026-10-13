import { error, json } from '@sveltejs/kit';
import { getVisiblePhotoBySlug, listPhotoNeighbors } from '$lib/server/services/photos';
import { isPhotoSlug } from '$lib/utils/slug';
import type { RequestHandler } from './$types';

/**
 * Public JSON for the overlay viewer (3c): given a photo slug, return the
 * photo's ±1 neighbours (viewer field set) and the 1-based feed position
 * used by the "i / N" counter. The detail page ships the same payload
 * inline; this endpoint serves the lazy fetches when the overlay walks past
 * the ±1 window (Q13: ←→ neighbours, URL kept in sync via
 * history.replaceState).
 *
 * Visibility is enforced by the same service loaders the page uses: an
 * invisible or missing photo is a plain 404 - never a JSON peek into hidden
 * content. Input that does not parse as a slug answers 404 BEFORE the
 * database is touched (same posture as `/i/<key>`; review 02 P3-1), and
 * retired slugs are deliberately NOT resolved through `slug_trackers`
 * (stricter than the page's single-hop 301; review 02 P3-2). The response
 * carries the live visibility decision, so it is never shared-cacheable
 * (review 02 P3-5), and `slug` is a request echo the client validates
 * against its in-flight navigation token - the full detail row stays off
 * the wire (review 04 P3-3).
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
