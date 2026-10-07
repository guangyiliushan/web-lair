import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { thoughts } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public 思考 detail (C3): uuid-addressed, language-neutral; malformed and
 * missing ids both answer 404 (uuid guard first - never query the column).
 */
export const load: PageServerLoad = async ({ params }) => {
	if (!isUuid(params.id)) throw error(404, 'Not found');
	const [row] = await db
		.select({
			id: thoughts.id,
			content: thoughts.content,
			createdAt: thoughts.createdAt
		})
		.from(thoughts)
		.where(eq(thoughts.id, params.id))
		.limit(1);
	if (!row) throw error(404, 'Not found');
	const siteTz = await getOption('site.timezone');
	const title = plainTextExcerpt(row.content, 48);
	return { row: { ...row, dateLabel: formatDate(row.createdAt, { timeZone: siteTz }) }, title };
};
