import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { fail, type Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { drafts, notes, topics } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { draftsForNotes, setNoteStatus } from '$lib/server/services/note-drafts';
import { syncFileReferences } from '$lib/server/services/file-references';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

const PAGE_SIZE = 20;
// `scheduled` stays out of the N1 UI (registered) - it is still reachable
// through All but has no filter chip of its own.
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

	// A note with a pending drafts row carries the "Unpublished changes" badge.
	const withDrafts = await draftsForNotes(rows.map((row) => row.id));

	return {
		headerTitle: m.admin_nav_notes(),
		headerActions: [
			{ label: m.admin_notes_topics(), iconName: 'external-link', href: '/admin/notes/topics' },
			{
				label: m.admin_common_new(),
				iconName: 'plus',
				variant: 'default',
				href: '/admin/notes/edit'
			}
		],
		notes: rows.map((row) => ({ ...row, hasDraft: withDrafts.has(row.id) })),
		totalCount: totals[0]?.count ?? 0,
		page,
		pageSize: PAGE_SIZE,
		filters: { status: statusRaw, topic: topicRaw, keyword },
		topics: allTopics
	};
};

export const actions: Actions = {
	/**
	 * Row-level status: move to trash / restore from trash (reuses the edit
	 * route's `setNoteStatus`, so the CAS + restore-target rules cannot drift).
	 *
	 * No redirect: the list keeps the caller's filters and the page invalidates.
	 */
	status: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		const action = (form.get('action') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_notes_edit_err_bad_id() });
		if (action !== 'trash' && action !== 'restore') {
			return fail(400, { error: m.admin_list_err_bad_action() });
		}

		const result = await setNoteStatus(id, action);
		if (result.kind === 'not-found') {
			return fail(404, { error: m.admin_notes_edit_err_not_found() });
		}
		if (result.kind === 'invalid') return fail(400, { error: result.message });
		return { success: true };
	},

	/**
	 * Permanent delete. Only offered from the overflow menu of a row that is
	 * already in the trash, so the destructive path is two deliberate steps
	 * (trash → purge) and a mis-click on the row button can never lose data.
	 *
	 * Mirrors the pages hard-delete (M1 / R2-3): drafts first, because
	 * `drafts.ref_id` is polymorphic and no FK can cascade for it; then the
	 * row (comments cascade, the translation pointer is set null); then the
	 * file-reference cleanup, in the same lock order publish and discard use.
	 */
	purge: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_notes_edit_err_bad_id() });

		const result = await db.transaction(async (tx) => {
			const [row] = await tx
				.select({ id: notes.id })
				.from(notes)
				.where(eq(notes.id, id))
				.limit(1)
				.for('update');
			if (!row) return { kind: 'not-found' as const };

			const draftRows = await tx
				.delete(drafts)
				.where(and(eq(drafts.refType, 'note'), eq(drafts.refId, id)))
				.returning({ id: drafts.id });
			await tx.delete(notes).where(eq(notes.id, id));
			for (const draft of draftRows) {
				await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
			}
			await syncFileReferences(tx, { type: 'note', id }, []);
			return { kind: 'deleted' as const };
		});

		if (result.kind === 'not-found') {
			return fail(404, { error: m.admin_notes_edit_err_not_found() });
		}
		return { success: true };
	}
};
