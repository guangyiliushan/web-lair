/**
 * Public gallery query grammar. Repeated keys carry multi-select filters:
 * `?year=2025&year=2026&camera=X-T5&tag=<uuid>&tagMode=all`.
 *
 * Pure and server-safe: the page load validates the same grammar the client
 * writes, so a hand-edited URL can never reach Postgres with a malformed year
 * or a non-UUID tag.
 */

export const PHOTO_COLUMNS = ['auto', '3', '4', '5'] as const;
export type PhotoColumns = (typeof PHOTO_COLUMNS)[number];
export type PhotoTagMode = 'any' | 'all';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_YEARS = 30;
const MAX_FACET_VALUES = 40;
const MAX_TAGS = 30;
const MAX_QUERY_LENGTH = 120;
const MAX_FACET_LENGTH = 120;

export interface PhotoQuery {
	years: number[];
	cameras: string[];
	lenses: string[];
	tagIds: string[];
	tagMode: PhotoTagMode;
	q: string;
	columns: PhotoColumns;
}

export const EMPTY_PHOTO_QUERY: PhotoQuery = {
	years: [],
	cameras: [],
	lenses: [],
	tagIds: [],
	tagMode: 'any',
	q: '',
	columns: 'auto'
};

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function facetValues(params: URLSearchParams, key: string): string[] {
	return unique(
		params
			.getAll(key)
			.map((value) => value.trim())
			.filter((value) => value !== '' && value.length <= MAX_FACET_LENGTH)
	).slice(0, MAX_FACET_VALUES);
}

/** Parse + shape-validate a gallery URL. Bad values are dropped, not thrown. */
export function parsePhotoQuery(params: URLSearchParams): PhotoQuery {
	const years = unique(
		params
			.getAll('year')
			.map((value) => value.trim())
			.filter((value) => /^\d{4}$/.test(value))
			.map(Number)
	).slice(0, MAX_YEARS);
	const tagIds = unique(
		params
			.getAll('tag')
			.map((value) => value.trim())
			.filter((value) => UUID_RE.test(value))
	).slice(0, MAX_TAGS);
	const columnsRaw = params.get('cols');
	const columns = PHOTO_COLUMNS.includes(columnsRaw as PhotoColumns)
		? (columnsRaw as PhotoColumns)
		: 'auto';

	return {
		years,
		cameras: facetValues(params, 'camera'),
		lenses: facetValues(params, 'lens'),
		tagIds,
		tagMode: params.get('tagMode') === 'all' ? 'all' : 'any',
		q: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH),
		columns
	};
}

/** Serialize filters in a stable order (cursor params are appended later). */
export function photoQueryParams(query: PhotoQuery): URLSearchParams {
	const params = new URLSearchParams();
	for (const year of query.years) params.append('year', String(year));
	for (const camera of query.cameras) params.append('camera', camera);
	for (const lens of query.lenses) params.append('lens', lens);
	for (const tag of query.tagIds) params.append('tag', tag);
	if (query.tagMode === 'all') params.set('tagMode', 'all');
	if (query.q !== '') params.set('q', query.q);
	if (query.columns !== 'auto') params.set('cols', query.columns);
	return params;
}

export type PhotoFilterKey = 'years' | 'cameras' | 'lenses' | 'tagIds';

/** Toggle one value in a multi-select axis and return a fresh query object. */
export function togglePhotoFilter(
	query: PhotoQuery,
	key: PhotoFilterKey,
	value: number | string
): PhotoQuery {
	const list = query[key] as Array<number | string>;
	const next = list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
	return { ...query, [key]: next } as PhotoQuery;
}

/** Number of active filter values (tag mode is a modifier, not a filter). */
export function activePhotoFilterCount(query: PhotoQuery): number {
	return (
		query.years.length +
		query.cameras.length +
		query.lenses.length +
		query.tagIds.length +
		(query.q !== '' ? 1 : 0)
	);
}

export function hasPhotoFilters(query: PhotoQuery): boolean {
	return activePhotoFilterCount(query) > 0;
}

/** Apply a patch and drop the cursor chain (any filter change resets paging). */
export function withPhotoQueryPatch(query: PhotoQuery, patch: Partial<PhotoQuery>): PhotoQuery {
	return { ...query, ...patch };
}

/** Query string without the leading `?` (empty when nothing is selected). */
export function photoQueryString(query: PhotoQuery): string {
	const params = photoQueryParams(query);
	return params.toString();
}
