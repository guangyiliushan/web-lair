import { desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { quotes } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public quotes waterfall (`摘录`): language-neutral rows, newest first. Streams as
 * a deferred promise so the page can render a skeleton immediately; dates are
 * formatted inside the continuation, where the request's locale context is still
 * active.
 */
export const load: PageServerLoad = async () => {
	const siteTz = await getOption('site.timezone');
	const rows = db
		.select({
			id: quotes.id,
			content: quotes.content,
			author: quotes.author,
			source: quotes.source,
			createdAt: quotes.createdAt
		})
		.from(quotes)
		.orderBy(desc(quotes.createdAt))
		.then((items) =>
			items.map((item) => ({
				...item,
				dateLabel: formatDate(item.createdAt, { timeZone: siteTz })
			}))
		);
	return { rows };
};
