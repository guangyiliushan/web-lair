import { listPublicPhotos } from '$lib/server/services/photos';
import type { PageServerLoad } from './$types';

/**
 * Public map (§8): every visible photo carrying coordinates, slimmed to what
 * the markers need. Bounded by the public list cap; a regional extract that
 * matches the spread is published on demand (registered decision).
 */
export const load: PageServerLoad = async () => {
	const rows = await listPublicPhotos({ hasLocation: true }, null, 200);
	const photos = rows
		.map((row) => ({
			slug: row.slug,
			title: row.title,
			latitude: Number(row.latitude),
			longitude: Number(row.longitude)
		}))
		.filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
	return { photos };
};
