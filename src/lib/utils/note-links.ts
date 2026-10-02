/**
 * Notes filter links (N1): single builder for the `/notes` list chips and
 * pagination so a chip click can never silently drop the other filter
 * dimension (review finding). Pure and client-safe.
 */
export interface NotesFilterState {
	topic: string | null;
	year: number | null;
}

export function notesFilterHref(
	current: NotesFilterState,
	next: { topic?: string | null; year?: number | null; page?: number }
): string {
	const topic = next.topic !== undefined ? next.topic : current.topic;
	const year = next.year !== undefined ? next.year : current.year;
	const query: string[] = [];
	if (topic) query.push(`topic=${encodeURIComponent(topic)}`);
	if (year !== null && year !== undefined) query.push(`year=${year}`);
	if (next.page && next.page > 1) query.push(`page=${next.page}`);
	return query.length > 0 ? `/notes?${query.join('&')}` : '/notes';
}
