import { fuzzCoordinate, listPublicPhotos, PHOTO_PAGE_MAX } from '$lib/server/services/photos';
import type { PageServerLoad } from './$types';

/**
 * Public map: every visible photo carrying coordinates, slimmed to what the markers
 * need and bounded by the public read cap (`PHOTO_PAGE_MAX`, the same clamp every
 * public list applies).
 */
export const load: PageServerLoad = async () => {
	const rows = await listPublicPhotos({ hasLocation: true }, null, PHOTO_PAGE_MAX);
	// Public coordinates render at two decimals (~1km blur); the admin face keeps
	// full precision, so the fuzz must happen at this boundary - skipping it leaks
	// exact values to the public client.
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
