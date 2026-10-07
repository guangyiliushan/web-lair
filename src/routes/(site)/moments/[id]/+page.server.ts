import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { moments } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public 微记 detail (C3): uuid-addressed, language-neutral; malformed and
 * missing ids both answer 404 (uuid guard first). Up/down counters render
 * read-only (voting interaction stays a registered item - no voter table).
 */
export const load: PageServerLoad = async ({ params }) => {
	if (!isUuid(params.id)) throw error(404, 'Not found');
	const [row] = await db
		.select({
			id: moments.id,
			content: moments.content,
			type: moments.type,
			up: moments.up,
			down: moments.down,
			createdAt: moments.createdAt
		})
		.from(moments)
		.where(eq(moments.id, params.id))
		.limit(1);
	if (!row) throw error(404, 'Not found');
	const siteTz = await getOption('site.timezone');
	const title = row.content.replace(/\s+/g, ' ').trim().slice(0, 48);
	return { row: { ...row, dateLabel: formatDate(row.createdAt, { timeZone: siteTz }) }, title };
};
