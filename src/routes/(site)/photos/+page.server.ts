import {
	listPhotoFacets,
	listPublicPhotos,
	type PublicPhotoCursor,
	type PublicPhotoFilters,
	type PublicPhotoItem
} from '$lib/server/services/photos';
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
const PAGE_SIZE = 24;
const MAX_CHAIN = 12;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export const load: PageServerLoad = ({ url }) => {
	const search = url.searchParams;
	const yearRaw = search.get('year')?.trim() ?? '';
	const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
	const camera = search.get('camera')?.trim() || null;
	const lens = search.get('lens')?.trim() || null;
	const tagRaw = search.get('tag')?.trim() ?? '';
	// tagId lands in a uuid column: a free-form value used to reach PG as
	// 22P02 and 500 the whole load (review round 1) — validate like cursors.
	const tag = UUID_RE.test(tagRaw) ? tagRaw : null;

	const filters: PublicPhotoFilters = {};
	if (year !== null) filters.year = year;
	if (camera) filters.cameraModel = camera;
	if (lens) filters.lensModel = lens;
	if (tag) filters.tagId = tag;

	let pages = 1;
	for (const raw of search.getAll('c')) {
		// Check BEFORE consuming an entry (review round 1): the old
		// increment-then-check shape let a 13th valid cursor fetch a 14th
		// page, one extra DB round-trip per request over the stated cap.
		if (pages >= MAX_CHAIN + 1) break;
		if (parseCursor(raw) === null) break;
		pages += 1;
	}

	const feed = (async () => {
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
				latitude: entry.latitude === null ? null : Number(entry.latitude).toFixed(2),
				longitude: entry.longitude === null ? null : Number(entry.longitude).toFixed(2)
			}));

		let moreHref: string | null = null;
		if (boundaries.length === pages) {
			const next = new URLSearchParams();
			if (year !== null) next.set('year', String(year));
			if (camera) next.set('camera', camera);
			if (lens) next.set('lens', lens);
			if (tag) next.set('tag', tag);
			for (const boundary of boundaries) next.append('c', cursorParam(boundary));
			moreHref = `?${next.toString()}`;
		}

		const facets = await listPhotoFacets();
		return { items: unique, facets, moreHref };
	})();

	return { filters: { year, camera, lens, tag }, feed };
};
