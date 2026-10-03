import { error } from '@sveltejs/kit';
import { getLocale } from '$lib/paraglide/runtime';
import { getOption } from '$lib/server/config/options-registry';
import { findTopicBySlug, listNotes, toNoteRow } from '$lib/server/services/notes';
import type { PageServerLoad } from './$types';

/** Topic page (N1): one curated topic's visible notes for this locale. */
export const load: PageServerLoad = async ({ params, url }) => {
	const lang = getLocale();
	const now = new Date();
	const siteTz = await getOption('site.timezone');

	const topic = await findTopicBySlug(params.slug);
	if (!topic) error(404, 'Topic not found');

	const pageParam = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
	const result = await listNotes({
		lang,
		page: Number.isNaN(pageParam) ? 1 : pageParam,
		// topicId is already resolved; the slug lookup would be redundant.
		topicId: topic.id,
		facets: false,
		siteTz,
		now
	});

	const notes = result.cards.map((card) => toNoteRow(card, siteTz));

	return {
		topic: {
			name: topic.name,
			slug: topic.slug,
			icon: topic.icon,
			description: topic.description
		},
		notes,
		total: result.total,
		page: result.page,
		totalPages: result.totalPages
	};
};
