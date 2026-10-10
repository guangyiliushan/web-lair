import { error, redirect } from '@sveltejs/kit';
import { getLocale, localizeHref, locales } from '$lib/paraglide/runtime';
import { findSlugTargetId } from '$lib/server/services/slug-resolver';
import {
	getVisiblePhotoById,
	getVisiblePhotoBySlug,
	listPhotoNeighbors,
	type PublicPhotoDetail
} from '$lib/server/services/photos';
import type { PageServerLoad } from './$types';

/**
 * Public photo viewer (v1). Photos are language agnostic: the tracker land
 * uses the default lang ('en') — the exact contract `updatePhoto` writes
 * with. A retired slug resolves through slug_trackers with a single 301 hop
 * (query string preserved); an invisible or missing target is a plain 404 —
 * never a redirect into hidden content.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const row: PublicPhotoDetail | null = await getVisiblePhotoBySlug(params.slug);

	if (!row) {
		const trackedId = await findSlugTargetId('photo', 'en', params.slug);
		if (trackedId) {
			const target = await getVisiblePhotoById(trackedId);
			if (target && target.slug !== params.slug) {
				const lang = getLocale() as (typeof locales)[number];
				redirect(301, localizeHref(`/photos/${target.slug}${url.search}`, { locale: lang }));
			}
		}
		error(404, 'Not found');
	}

	const neighbors = await listPhotoNeighbors({
		sortAt: row.takenAt ?? row.createdAt,
		id: row.id
	});

	return {
		seo: { path: `/photos/${row.slug}` },
		photo: row,
		neighbors
	};
};
