import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { quotes } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public 摘录 detail (C3): uuid-addressed and language-neutral. A malformed
 * id never reaches the uuid column (22P02 guard) and both malformed and
 * missing ids answer a plain 404.
 */
export const load: PageServerLoad = async ({ params }) => {
	if (!isUuid(params.id)) throw error(404, 'Not found');
	const [row] = await db
		.select({
			id: quotes.id,
			content: quotes.content,
			author: quotes.author,
			source: quotes.source,
			createdAt: quotes.createdAt
		})
		.from(quotes)
		.where(eq(quotes.id, params.id))
		.limit(1);
	if (!row) throw error(404, 'Not found');
	const siteTz = await getOption('site.timezone');
	const title = plainTextExcerpt(row.content, 48);
	return { row: { ...row, dateLabel: formatDate(row.createdAt, { timeZone: siteTz }) }, title };
};
