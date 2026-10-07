import { desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { quotes } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public 摘录 waterfall (C3): language-neutral rows, newest first. Streams as
 * a deferred promise so the page can show the ui-ux plan C1 Skeleton; dates
 * are formatted inside the continuation (the request's locale context is
 * still active there).
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
