/**
 * Shared list-view contract for /posts: URL values, URL builder and the one
 * whitelist the server and the page both use. Keeping the neutral path here
 * (no locale prefix) means the server can parse and the component can
 * localise without duplicating the query-string rules.
 */
export const POST_SORTS = ['latest', 'oldest', 'updated'] as const;

export type PostSort = (typeof POST_SORTS)[number];

/** Public list filters. `non-generated` is an author declaration, not a check. */
export const POST_AI_FILTERS = ['non-generated'] as const;

export type PostAiFilter = (typeof POST_AI_FILTERS)[number];

export const DEFAULT_POST_SORT: PostSort = 'latest';

/** Single page-size source for the load, the pager and the list tests. */
export const POSTS_PAGE_SIZE = 10;

/** Unknown values fall back to the default instead of throwing (public page). */
export function parsePostSort(value: string | null | undefined): PostSort {
	return value && (POST_SORTS as readonly string[]).includes(value)
		? (value as PostSort)
		: DEFAULT_POST_SORT;
}

/** Unknown values fall back to no filter (public page); the URL still decides variant-ness. */
export function parsePostAiFilter(value: string | null | undefined): PostAiFilter | null {
	return value && (POST_AI_FILTERS as readonly string[]).includes(value)
		? (value as PostAiFilter)
		: null;
}

/**
 * Canonical list href: default sort and page 1 are omitted so the base URL
 * stays clean. Callers localise the result (`localizeHref`).
 */
export function postListHref(
	options: { sort?: PostSort; page?: number; ai?: PostAiFilter } = {}
): string {
	const params = new URLSearchParams();
	if (options.ai) params.set('ai', options.ai);
	if (options.sort && options.sort !== DEFAULT_POST_SORT) params.set('sort', options.sort);
	if (options.page && options.page > 1) params.set('page', String(options.page));
	const query = params.toString();
	return `/posts${query ? `?${query}` : ''}`;
}
