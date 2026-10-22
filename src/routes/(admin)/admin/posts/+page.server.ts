import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { fail, type Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories, drafts, posts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
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

	const [rows, totals, allCategories] = await Promise.all([
		db
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
				createdAt: posts.createdAt,
				updatedAt: posts.updatedAt,
				publishedAt: posts.publishedAt
			})
			.from(posts)
			.leftJoin(categories, eq(posts.categoryId, categories.id))
			.where(where)
			.orderBy(desc(posts.updatedAt))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		db
			.select({ count: sql<number>`count(*)`.mapWith(Number) })
			.from(posts)
			.where(where),
		db
			.select({ id: categories.id, name: categories.name, slug: categories.slug })
			.from(categories)
			.orderBy(categories.name)
	]);

	const withDrafts = await draftsForPosts(rows.map((r) => r.id));

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
		posts: rows.map((row) => ({ ...row, hasDraft: withDrafts.has(row.id) })),
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
	 * row (comments / revisions / related posts / tags cascade); then the
	 * file-reference cleanup, in the same lock order publish and discard use.
	 */
	purge: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_posts_edit_err_bad_post_id() });

		const result = await db.transaction(async (tx) => {
			const [row] = await tx
				.select({ id: posts.id })
				.from(posts)
				.where(eq(posts.id, id))
				.limit(1)
				.for('update');
			if (!row) return { kind: 'not-found' as const };

			const draftRows = await tx
				.delete(drafts)
				.where(and(eq(drafts.refType, 'post'), eq(drafts.refId, id)))
				.returning({ id: drafts.id });
			await tx.delete(posts).where(eq(posts.id, id));
			for (const draft of draftRows) {
				await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
			}
			await syncFileReferences(tx, { type: 'post', id }, []);
			return { kind: 'deleted' as const };
		});

		if (result.kind === 'not-found')
			return fail(404, { error: m.admin_posts_edit_err_not_found() });
		return { success: true };
	}
};
