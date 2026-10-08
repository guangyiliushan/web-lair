import { asc, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { projects } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public projects grid (P batch, plan §5): published rows only, ordered by
 * `sort_order ASC, created_at DESC`. The pushed-at label is formatted here
 * in the site timezone so the card stays presentational. Streams for the
 * ui-ux Skeleton pattern.
 */
export const load: PageServerLoad = async () => {
	const siteTz = await getOption('site.timezone');
	const rows = db
		.select({
			id: projects.id,
			name: projects.name,
			description: projects.description,
			provider: projects.provider,
			projectUrl: projects.projectUrl,
			previewUrl: projects.previewUrl,
			docUrl: projects.docUrl,
			avatar: projects.avatar,
			language: projects.language,
			stars: projects.stars,
			pushedAt: projects.pushedAt,
			archived: projects.archived
		})
		.from(projects)
		.where(eq(projects.status, 'published'))
		.orderBy(asc(projects.sortOrder), desc(projects.createdAt))
		.then((items) =>
			items.map((item) => ({
				...item,
				pushedLabel: item.pushedAt ? formatDate(item.pushedAt, { timeZone: siteTz }) : null
			}))
		);
	return { rows };
};
