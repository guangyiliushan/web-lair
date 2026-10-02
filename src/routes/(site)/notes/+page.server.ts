import { getLocale } from '$lib/paraglide/runtime';
import { getOption } from '$lib/server/config/options-registry';
import { listNotes } from '$lib/server/services/notes';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public notes list (N1): belongs-to year / topic filters, pin-first order
 * on page one, gated rows reduced to title + lock. Filtered views are
 * noindex-neutral - they consolidate on `/notes` via the page canonical.
 */
export const load: PageServerLoad = async ({ url }) => {
	const lang = getLocale();
	const now = new Date();
	const siteTz = await getOption('site.timezone');

	const pageParam = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
	const yearParam = Number.parseInt(url.searchParams.get('year') ?? '', 10);
	const year = Number.isNaN(yearParam) ? null : yearParam;
	const topicSlug = url.searchParams.get('topic');

	const result = await listNotes({
		lang,
		page: Number.isNaN(pageParam) ? 1 : pageParam,
		year,
		topicSlug,
		now
	});

	type Row = {
		slug: string;
		title: string;
		locked: boolean;
		excerpt: string | null;
		image: string | null;
		date: string;
	};
	const toRow = (card: (typeof result.cards)[number]): Row => ({
		slug: card.slug,
		title: card.title,
		locked: card.locked,
		excerpt: card.excerpt,
		image: card.image,
		date: formatDate(card.publishedAt, { timeZone: card.tz ?? siteTz })
	});

	const pinnedCard = result.page === 1 ? result.cards.find((card) => card.pinned) : undefined;
	const pinnedNote = pinnedCard ? { ...toRow(pinnedCard), pinned: true } : null;
	const notes = result.cards.filter((card) => card !== pinnedCard).map(toRow);

	return {
		notes,
		pinnedNote,
		total: result.total,
		page: result.page,
		totalPages: result.totalPages,
		years: result.years,
		topics: result.topics,
		filters: { year, topic: topicSlug }
	};
};
