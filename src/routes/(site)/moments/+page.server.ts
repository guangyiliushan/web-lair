import { desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { moments } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { formatDate } from '$lib/utils/i18n';
import { isMomentKind } from '$lib/utils/moment-meta';
import type { PageServerLoad } from './$types';

/**
 * Public 微记 stream (C3): language-neutral rows with a `?kind=` filter
 * (validated against the shared whitelist; an unknown kind shows the
 * unfiltered stream rather than 404ing a filter chip). Streams for the ui-ux
 * plan C1 Skeleton.
 */
export const load: PageServerLoad = async ({ url }) => {
	const siteTz = await getOption('site.timezone');
	const rawKind = url.searchParams.get('kind') ?? '';
	const kind = isMomentKind(rawKind) ? rawKind : null;
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
				dateLabel: formatDate(item.createdAt, { timeZone: siteTz })
			}))
		);
	return { rows, kind };
};
