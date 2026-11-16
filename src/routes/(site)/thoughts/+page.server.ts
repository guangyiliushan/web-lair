import { desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { thoughts } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public thoughts stream (`思考`): language-neutral rows, newest first. Streams as a
 * deferred promise so the page can render a skeleton; dates format inside the
 * continuation so the request's locale context applies.
 */
export const load: PageServerLoad = async () => {
	const siteTz = await getOption('site.timezone');
	const rows = db
		.select({
			id: thoughts.id,
			content: thoughts.content,
			createdAt: thoughts.createdAt
		})
		.from(thoughts)
		.orderBy(desc(thoughts.createdAt))
		.then((items) =>
			items.map((item) => ({
				...item,
				dateLabel: formatDate(item.createdAt, { timeZone: siteTz })
			}))
		);
	return { rows };
};
