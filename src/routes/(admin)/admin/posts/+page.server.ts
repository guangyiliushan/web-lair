import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { fail, type Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories, drafts, posts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { OPTION_LANGS } from '$lib/server/config/options-registry';
import { draftsForPosts } from '$lib/server/services/post-drafts';
import { syncFileReferences } from '$lib/server/services/file-references';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

const PAGE_SIZE = 20;
const STATUSES = ['published', 'draft', 'scheduled', 'trash'] as const;

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	const statusRaw = url.searchParams.get('status') ?? '';
	const categoryRaw = url.searchParams.get('category') ?? '';
	const keyword = (url.searchParams.get('keyword') ?? '').trim();
	// Number() accepts Infinity / 1e999 and the DB offset does not (a read-only
	// probe turned ?page=Infinity into a 500; review finding).
	const rawPage = Number(url.searchParams.get('page') ?? '1');
	const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;

	// P2: the list reads the real table; a post with a pending drafts row
	// carries the "Unpublished changes" badge.
	const conditions = [];
	if ((STATUSES as readonly string[]).includes(statusRaw)) {
		conditions.push(eq(posts.status, statusRaw));
	}
	if (categoryRaw && isUuid(categoryRaw)) conditions.push(eq(posts.categoryId, categoryRaw));
	if (keyword) conditions.push(ilike(posts.title, `%${keyword}%`));
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	// 译文与原文合并成一行（UX-1020）：按 translation_group 分页，行内给出
	// 每个语言的状态。先分页到组再取成员，家庭不会被页边界劈开。
	const [groups, totals, allCategories] = await Promise.all([
		db
			.select({ group: posts.translationGroup })
			.from(posts)
			.where(where)
			.groupBy(posts.translationGroup)
			.orderBy(desc(sql`max(${posts.updatedAt})`))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		db
			.select({ count: sql<number>`count(distinct ${posts.translationGroup})`.mapWith(Number) })
			.from(posts)
			.where(where),
		db
			.select({ id: categories.id, name: categories.name, slug: categories.slug })
			.from(categories)
			.orderBy(categories.name)
	]);

	const groupIds = groups.map((g) => g.group);
	const rows =
		groupIds.length === 0
			? []
			: await db
					.select({
						id: posts.id,
						title: posts.title,
						slug: posts.slug,
						status: posts.status,
						lang: posts.lang,
						readCount: posts.readCount,
						likeCount: posts.likeCount,
						categoryId: posts.categoryId,
						categoryName: categories.name,
						translationGroup: posts.translationGroup,
						translatedFromPostId: posts.translatedFromPostId,
						createdAt: posts.createdAt,
						updatedAt: posts.updatedAt,
						publishedAt: posts.publishedAt
					})
					.from(posts)
					.leftJoin(categories, eq(posts.categoryId, categories.id))
					.where(inArray(posts.translationGroup, groupIds))
					.orderBy(desc(posts.updatedAt));

	const withDrafts = await draftsForPosts(rows.map((r) => r.id));

	// Fold the family into one row: the group SOURCE is the identity (title /
	// slug / actions), and its translations ride along as a language chain.
	const byGroup = new Map<string, typeof rows>();
	for (const row of rows) {
		const bucket = byGroup.get(row.translationGroup);
		if (bucket) bucket.push(row);
		else byGroup.set(row.translationGroup, [row]);
	}
	const families = groupIds.flatMap((group) => {
		const members = (byGroup.get(group) ?? []).slice().sort((a, b) => {
			// Source first, then the language order the editor uses.
			if (!a.translatedFromPostId !== !b.translatedFromPostId)
				return a.translatedFromPostId ? 1 : -1;
			return a.lang.localeCompare(b.lang);
		});
		const head = members.find((member) => !member.translatedFromPostId) ?? members[0];
		if (!head) return [];
		return [
			{
				...head,
				hasDraft: withDrafts.has(head.id),
				// NB: never name this parameter "m" - it would shadow the
				// paraglide message object, and the i18n guard would read these
				// property accesses as message keys.
				langs: members.map((member) => ({
					lang: member.lang,
					id: member.id,
					status: member.status,
					hasDraft: withDrafts.has(member.id),
					isSource: !member.translatedFromPostId
				}))
			}
		];
	});

	return {
		headerTitle: m.admin_nav_posts(),
		headerActions: [
			{ label: m.nav_posts_categories(), iconName: 'category', href: '/admin/posts/categories' },
			{ label: m.admin_tags_nav(), iconName: 'tag', href: '/admin/posts/tags' },
			{ label: m.admin_nav_drafts(), iconName: 'draft', href: '/admin/drafts' },
			{
				label: m.admin_common_new(),
				iconName: 'plus',
				variant: 'default',
				href: '/admin/posts/edit'
			}
		],
		posts: families,
		langs: [...OPTION_LANGS],
		totalCount: totals[0]?.count ?? 0,
		page,
		pageSize: PAGE_SIZE,
		filters: { status: statusRaw, category: categoryRaw, keyword },
		categories: allCategories
	};
};

export const actions: Actions = {
	/**
	 * Row-level status: move to trash / restore from trash. Restoring returns
	 * the post to `published` when it had been public before (`publishedAt` is
	 * the only durable trace of "was public"), otherwise to `draft` — the same
	 * rule `setNoteStatus` applies to notes.
	 *
	 * No redirect: the list keeps the caller's filters and the page invalidates.
	 */
	status: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		const action = (form.get('action') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_posts_edit_err_bad_post_id() });
		if (action !== 'trash' && action !== 'restore') {
			return fail(400, { error: m.admin_list_err_bad_action() });
		}

		const [current] = await db
			.select({ id: posts.id, status: posts.status, publishedAt: posts.publishedAt })
			.from(posts)
			.where(eq(posts.id, id))
			.limit(1);
		if (!current) return fail(404, { error: m.admin_posts_edit_err_not_found() });

		const target = action === 'trash' ? 'trash' : current.publishedAt ? 'published' : 'draft';
		if (current.status === target) return { success: true };

		// CAS on the status we read: a concurrent publish/restore must not be
		// overwritten blind (mirrors setNoteStatus).
		const rows = await db
			.update(posts)
			.set({ status: target, updatedAt: new Date() })
			.where(and(eq(posts.id, id), eq(posts.status, current.status)))
			.returning({ id: posts.id });
		if (rows.length === 0) return fail(409, { error: m.admin_posts_edit_err_busy() });
		return { success: true };
	},

	/**
	 * Permanent delete. Only offered from the overflow menu of a row that is
	 * already in the trash, so the destructive path is two deliberate steps
	 * (trash → purge) and a mis-click on the row button can never lose data.
	 *
	 * Mirrors the pages hard-delete (M1 / R2-3): drafts first, because
	 * `drafts.ref_id` is polymorphic and no FK can cascade for it; then the
	 * rows (comments / revisions / related posts / tags cascade); then the
	 * file-reference cleanup, in the same lock order publish and discard use.
	 *
	 * A source row anchors its translation family, and the DB keeps exactly one
	 * source per group (`posts_group_source_uniq`). Purging it therefore purges
	 * the whole family: siblings are deleted FIRST, because letting the
	 * self-FK's `SET NULL` run while the source is still there makes every
	 * sibling a second "source" and violates that index (the old 500).
	 */
	purge: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_posts_edit_err_bad_post_id() });

		const result = await db.transaction(async (tx) => {
			const [row] = await tx
				.select({
					id: posts.id,
					translationGroup: posts.translationGroup,
					translatedFromPostId: posts.translatedFromPostId
				})
				.from(posts)
				.where(eq(posts.id, id))
				.limit(1)
				.for('update');
			if (!row) return { kind: 'not-found' as const };

			const siblings =
				row.translatedFromPostId === null
					? (
							await tx
								.select({ id: posts.id })
								.from(posts)
								.where(eq(posts.translationGroup, row.translationGroup))
								.for('update')
						)
							.map((member) => member.id)
							.filter((memberId) => memberId !== row.id)
					: [];

			const draftRows = await tx
				.delete(drafts)
				.where(and(eq(drafts.refType, 'post'), inArray(drafts.refId, [row.id, ...siblings])))
				.returning({ id: drafts.id });
			for (const memberId of siblings) {
				await tx.delete(posts).where(eq(posts.id, memberId));
			}
			await tx.delete(posts).where(eq(posts.id, row.id));
			for (const draft of draftRows) {
				await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
			}
			for (const memberId of siblings) {
				await syncFileReferences(tx, { type: 'post', id: memberId }, []);
			}
			await syncFileReferences(tx, { type: 'post', id: row.id }, []);
			return { kind: 'deleted' as const };
		});

		if (result.kind === 'not-found')
			return fail(404, { error: m.admin_posts_edit_err_not_found() });
		return { success: true };
	}
};
