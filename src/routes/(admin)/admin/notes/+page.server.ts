import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { notes, topics } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { draftsForNotes } from '$lib/server/services/note-drafts';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 20;
// `scheduled` stays out of the N1 UI (registered) - it is still reachable
// through 全部 but has no filter chip of its own.
const STATUSES = ['published', 'draft', 'private', 'trash'] as const;

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	const statusRaw = url.searchParams.get('status') ?? '';
	const topicRaw = url.searchParams.get('topic') ?? '';
	const keyword = (url.searchParams.get('keyword') ?? '').trim();
	// Number() accepts Infinity / 1e999 and the DB offset does not (mirrors
	// the posts list guard).
	const rawPage = Number(url.searchParams.get('page') ?? '1');
	const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;

	const conditions = [];
	if ((STATUSES as readonly string[]).includes(statusRaw)) {
		conditions.push(eq(notes.status, statusRaw));
	}
	if (topicRaw && isUuid(topicRaw)) conditions.push(eq(notes.topicId, topicRaw));
	if (keyword) conditions.push(ilike(notes.title, `%${keyword}%`));
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const [rows, totals, allTopics] = await Promise.all([
		db
			.select({
				id: notes.id,
				nid: notes.nid,
				title: notes.title,
				slug: notes.slug,
				lang: notes.lang,
				status: notes.status,
				mood: notes.mood,
				weatherCode: notes.weatherCode,
				temperatureC: notes.temperatureC,
				readCount: notes.readCount,
				likeCount: notes.likeCount,
				topicId: notes.topicId,
				topicName: topics.name,
				pinned: sql<boolean>`${notes.pinAt} is not null`.mapWith(Boolean),
				locked: sql<boolean>`${notes.passwordHash} is not null`.mapWith(Boolean),
				createdAt: notes.createdAt,
				updatedAt: notes.updatedAt,
				publishedAt: notes.publishedAt
			})
			.from(notes)
			.leftJoin(topics, eq(notes.topicId, topics.id))
			.where(where)
			.orderBy(desc(notes.updatedAt))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		db
			.select({ count: sql<number>`count(*)`.mapWith(Number) })
			.from(notes)
			.where(where),
		db
			.select({ id: topics.id, name: topics.name, slug: topics.slug })
			.from(topics)
			.orderBy(topics.sortOrder, topics.name)
	]);

	// A note with a pending drafts row carries the "有未发布改动" badge.
	const withDrafts = await draftsForNotes(rows.map((row) => row.id));

	return {
		headerTitle: '手记',
		headerActions: [
			{ label: '专栏', iconName: 'external-link', href: '/admin/notes/topics' },
			{ label: '新建', iconName: 'plus', variant: 'default', href: '/admin/notes/edit' }
		],
		notes: rows.map((row) => ({ ...row, hasDraft: withDrafts.has(row.id) })),
		totalCount: totals[0]?.count ?? 0,
		page,
		pageSize: PAGE_SIZE,
		filters: { status: statusRaw, topic: topicRaw, keyword },
		topics: allTopics
	};
};
