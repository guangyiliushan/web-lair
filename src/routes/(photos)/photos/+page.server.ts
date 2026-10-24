import {
	countPublicPhotos,
	fuzzCoordinate,
	listPhotoFacets,
	listPublicPhotos,
	PHOTO_PAGE_DEFAULT,
	type PublicPhotoCursor,
	type PublicPhotoFilters,
	type PublicPhotoItem
} from '$lib/server/services/photos';
import { parsePhotoQuery, photoQueryParams, UUID_RE, type PhotoQuery } from '$lib/photos/query';
import type { PageServerLoad } from './$types';

/**
 * Public gallery feed (§5.1): keyset pagination on `(sort_at, id) DESC` with
 * a stateless "load more" chain. Every shown page boundary travels as a `c`
 * query param (`<iso>~<id>`), so the button is a plain link that works
 * without JS; the route always re-fetches from page one and RECOMPUTES the
 * boundaries from the actual rows — stored cursors only bound the chain
 * length, they are never trusted as query values. A malformed entry ends the
 * chain at that point; the chain is capped regardless.
 */
const PAGE_SIZE = PHOTO_PAGE_DEFAULT;
const MAX_CHAIN = 12;

function parseCursor(raw: string): PublicPhotoCursor | null {
	const separator = raw.lastIndexOf('~');
	if (separator <= 0) return null;
	const id = raw.slice(separator + 1);
	if (!UUID_RE.test(id)) return null;
	const parsed = new Date(raw.slice(0, separator));
	if (Number.isNaN(parsed.getTime())) return null;
	return { sortAt: parsed.toISOString(), id };
}

function cursorParam(cursor: PublicPhotoCursor): string {
	return `${cursor.sortAt}~${cursor.id}`;
}

function toPublicFilters(query: PhotoQuery): PublicPhotoFilters {
	const filters: PublicPhotoFilters = {};
	if (query.years.length > 0) filters.years = query.years;
	if (query.cameras.length > 0) filters.cameraModels = query.cameras;
	if (query.lenses.length > 0) filters.lensModels = query.lenses;
	if (query.tagIds.length > 0) {
		filters.tagIds = query.tagIds;
		filters.tagMode = query.tagMode;
	}
	if (query.q !== '') filters.query = query.q;
	return filters;
}

export const load: PageServerLoad = ({ url }) => {
	const search = url.searchParams;
	const query = parsePhotoQuery(search);
	const filters = toPublicFilters(query);

	let pages = 1;
	for (const raw of search.getAll('c')) {
		// Check BEFORE consuming an entry: the old increment-then-check shape
		// let a 13th valid cursor fetch a 14th page, one extra DB round-trip
		// per request over the stated cap.
		if (pages >= MAX_CHAIN + 1) break;
		if (parseCursor(raw) === null) break;
		pages += 1;
	}

	const totalPromise = countPublicPhotos(filters);
	const facetsPromise = listPhotoFacets();

	const feed = (async () => {
		try {
			const items: PublicPhotoItem[] = [];
			const boundaries: PublicPhotoCursor[] = [];
			let cursor: PublicPhotoCursor | null = null;
			for (let index = 0; index < pages; index += 1) {
				const page = await listPublicPhotos(filters, cursor, PAGE_SIZE);
				items.push(...page);
				if (page.length < PAGE_SIZE) break;
				const last = page[page.length - 1]!;
				cursor = { sortAt: (last.takenAt ?? last.createdAt).toISOString(), id: last.id };
				boundaries.push(cursor);
			}

			// A cursor/filter drift could double-serve one boundary row; ids win.
			// Public coordinates are fuzzed to two decimals at the read boundary
			// (plan §5.1: ~1km render-time blur; the admin face keeps full
			// precision — review round 1 caught the exact values leaking here).
			const seen = new Set<string>();
			const unique = items
				.filter((entry) => !seen.has(entry.id) && (seen.add(entry.id), true))
				.map((entry) => ({
					...entry,
					latitude: fuzzCoordinate(entry.latitude),
					longitude: fuzzCoordinate(entry.longitude)
				}));

			let moreHref: string | null = null;
			if (boundaries.length === pages) {
				const next = photoQueryParams(query);
				for (const boundary of boundaries) next.append('c', cursorParam(boundary));
				moreHref = `?${next.toString()}`;
			}

			const [facets, total] = await Promise.all([facetsPromise, totalPromise]);
			return { items: unique, facets, total, moreHref };
		} catch (error) {
			// The count/facets reads started in parallel with pagination; a
			// page failure must not leave their rejections unhandled.
			await Promise.allSettled([facetsPromise, totalPromise]);
			throw error;
		}
	})();

	return { query, feed };
};
