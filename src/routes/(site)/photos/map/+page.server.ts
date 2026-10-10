import { fuzzCoordinate, listPublicPhotos, PHOTO_PAGE_MAX } from '$lib/server/services/photos';
import type { PageServerLoad } from './$types';

/**
 * Public map (§8): every visible photo carrying coordinates, slimmed to what
 * the markers need. Bounded by the public read cap (PHOTO_PAGE_MAX = 200 —
 * the old 60 clamp silently truncated the map's request; round-2 review);
 * a regional extract that matches the spread is published on demand
 * (registered decision).
 */
export const load: PageServerLoad = async () => {
	const rows = await listPublicPhotos({ hasLocation: true }, null, PHOTO_PAGE_MAX);
	// Plan §5.1: public coordinates render at two decimals (~1km blur); the
	// admin face keeps full precision (review round 1: exact values used to
	// reach the public client here).
	const photos = rows
		.map((row) => ({
			slug: row.slug,
			title: row.title,
			latitude: Number(fuzzCoordinate(row.latitude) ?? Number.NaN),
			longitude: Number(fuzzCoordinate(row.longitude) ?? Number.NaN)
		}))
		.filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
	return { photos };
};
