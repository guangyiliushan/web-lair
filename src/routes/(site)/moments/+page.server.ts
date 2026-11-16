import { desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { moments } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { formatDate } from '$lib/utils/i18n';
import { parseMomentKind } from '$lib/utils/moment-meta';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import type { PageServerLoad } from './$types';

/**
 * Public micro-post stream (`微记`): language-neutral rows with a `?kind=` filter
 * validated against the shared whitelist — an unknown kind shows the unfiltered
 * stream rather than 404ing a filter chip. Streams so the page can render a
 * skeleton immediately.
 */
export const load: PageServerLoad = async ({ url }) => {
	const siteTz = await getOption('site.timezone');
	const rawKind = url.searchParams.get('kind') ?? '';
	const kind = parseMomentKind(rawKind);
	const rows = db
		.select({
			id: moments.id,
			content: moments.content,
			type: moments.type,
			up: moments.up,
			down: moments.down,
			createdAt: moments.createdAt
		})
		.from(moments)
		.where(kind ? eq(moments.type, kind) : undefined)
		.orderBy(desc(moments.createdAt))
		.then((items) =>
			items.map((item) => ({
				...item,
				// Markdown bodies are authored in the admin editor; the stream
				// stays a plain-text preview (full rendering lives on the
				// detail page - no per-row unified pass over the whole table).
				excerpt: plainTextExcerpt(item.content),
				dateLabel: formatDate(item.createdAt, { timeZone: siteTz })
			}))
		);
	return { rows, kind };
};
