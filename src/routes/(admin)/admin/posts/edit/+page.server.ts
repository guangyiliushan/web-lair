import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, postTags, posts, tags } from '$lib/server/db/content';
import { parseTags, validatePostForm } from '$lib/server/services/posts';
import { isUuid } from '$lib/utils/uuid';
import { tagSlug } from '$lib/utils/slug';
import type { PageServerLoad, Actions } from './$types';

/** The editor still speaks a publish boolean; P1 maps it onto the status machine. */
const DEFAULT_LANG = 'en';

/** Field-keyed errors plus a form-level fallback row (rendered joined with the rest). */
type EditorErrors = Partial<
	Record<'title' | 'slug' | 'categoryId' | 'summary' | 'content' | 'form', string>
>;

/** drizzle wraps driver errors (DrizzleQueryError); the PG code lives on the cause. */
function pgErrorCode(caught: unknown): string | undefined {
	const err = caught as { code?: string; cause?: { code?: string } } | null;
	return err?.code ?? err?.cause?.code;
}

async function loadTagNames(postId: string): Promise<string[]> {
	const rows = await db
		.select({ name: tags.name })
		.from(postTags)
		.innerJoin(tags, eq(postTags.tagId, tags.id))
		.where(eq(postTags.postId, postId))
		.orderBy(tags.name);
	return rows.map((r) => r.name);
}

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Replace a post's tags. Runs inside the caller's transaction so the article
 * write and its tag wiring land together (P1.1 review: a mid-way failure used
 * to leave a saved article with its tags wiped).
 *
 * Display name is first-writer-wins: an existing tag keeps its stored name, so
 * a stray case/space variant on a later post cannot rename it site-wide
 * (`set: { name: tags.name }` also returns the row id for the junction).
 */
async function syncPostTags(executor: DbExecutor, postId: string, names: string[]) {
	await executor.delete(postTags).where(eq(postTags.postId, postId));
	for (const name of names) {
		const slug = tagSlug(name);
		const [tag] = await executor
			.insert(tags)
			.values({ name, slug })
			.onConflictDoUpdate({ target: tags.slug, set: { name: sql`${tags.name}` } })
			.returning({ id: tags.id });
		await executor.insert(postTags).values({ postId, tagId: tag.id }).onConflictDoNothing();
	}
}

export const load: PageServerLoad = async ({ url }) => {
	const allCategories = await db
		.select({ id: categories.id, name: categories.name, slug: categories.slug })
		.from(categories)
		.orderBy(categories.name);

	// ?id= loads an existing post for editing; without it this page creates a new post.
	const id = url.searchParams.get('id');
	if (id && !isUuid(id)) error(404, '文章不存在');
	let post = null;
	if (id) {
		const [row] = await db
			.select({
				id: posts.id,
				title: posts.title,
				slug: posts.slug,
				categoryId: posts.categoryId,
				summary: posts.summary,
				content: posts.content,
				status: posts.status,
				createdAt: posts.createdAt,
				updatedAt: posts.updatedAt
			})
			.from(posts)
			.where(eq(posts.id, id))
			.limit(1);
		if (!row) error(404, '文章不存在');
		const tagNames = await loadTagNames(row.id);
		post = {
			...row,
			isPublished: row.status === 'published',
			tags: tagNames.join(',')
		};
	}

	return {
		headerTitle: '博文',
		headerActions: [
			{ label: '返回', iconName: 'arrow-left', variant: 'outline', href: '/admin/posts' }
		],
		categories: allCategories,
		post,
		aiAvailable: false
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const formData = await request.formData();
		const rawId = formData.get('id')?.toString().trim() ?? '';
		const tagsRaw = formData.get('tags')?.toString() ?? '';
		const values = {
			title: formData.get('title')?.toString().trim() ?? '',
			slug: formData.get('slug')?.toString().trim().toLowerCase() ?? '',
			categoryId: formData.get('categoryId')?.toString() ?? '',
			summary: formData.get('summary')?.toString().trim() ?? '',
			content: formData.get('content')?.toString() ?? '',
			tags: tagsRaw,
			isPublished: formData.get('isPublished') === 'true'
		};

		// Malformed ids are rejected before they can reach the uuid columns -
		// PostgreSQL would raise 22P02, which used to surface as a 500 (P1.1).
		const errors: EditorErrors = validatePostForm(values);
		if (rawId && !isUuid(rawId)) {
			errors.form = '文章标识无效，请从列表重新进入。';
		}
		if (values.categoryId && !isUuid(values.categoryId)) {
			errors.categoryId = '请选择有效的分类';
		}
		if (Object.keys(errors).length > 0) {
			return fail(400, { errors, values });
		}

		// Slug uniqueness inside the row's own language (P2 adds the language
		// picker); on update the existing row's lang is authoritative.
		let targetLang = DEFAULT_LANG;
		if (rawId) {
			const [existing] = await db
				.select({ lang: posts.lang })
				.from(posts)
				.where(eq(posts.id, rawId))
				.limit(1);
			if (!existing) error(404, '文章不存在');
			targetLang = existing.lang;
		}
		const slugOwner = await db.query.posts.findFirst({
			where: rawId
				? and(eq(posts.lang, targetLang), eq(posts.slug, values.slug), ne(posts.id, rawId))
				: and(eq(posts.lang, targetLang), eq(posts.slug, values.slug)),
			columns: { id: true }
		});
		if (slugOwner) {
			return fail(400, {
				errors: { ...errors, slug: '该 Slug 已被其他文章使用' },
				values
			});
		}

		const tagNames = parseTags(tagsRaw);
		const now = new Date();

		let postId: string;
		try {
			postId = await db.transaction(async (tx) => {
				let id: string;
				if (rawId) {
					const updated = await tx
						.update(posts)
						.set({
							title: values.title,
							slug: values.slug,
							categoryId: values.categoryId,
							content: values.content,
							summary: values.summary || null,
							status: values.isPublished ? 'published' : 'draft',
							updatedAt: now,
							// First publish stamps published_at; later saves keep it (§9.8).
							...(values.isPublished
								? { publishedAt: sql`coalesce(${posts.publishedAt}, now())` }
								: {})
						})
						.where(eq(posts.id, rawId))
						.returning({ id: posts.id });
					if (updated.length === 0) error(404, '文章不存在');
					id = updated[0].id;
				} else {
					const [created] = await tx
						.insert(posts)
						.values({
							title: values.title,
							slug: values.slug,
							categoryId: values.categoryId,
							content: values.content,
							contentFormat: 'markdown',
							summary: values.summary || null,
							status: values.isPublished ? 'published' : 'draft',
							publishedAt: values.isPublished ? now : null,
							createdAt: now,
							updatedAt: now
						})
						.returning({ id: posts.id });
					id = created.id;
				}
				await syncPostTags(tx, id, tagNames);
				return id;
			});
		} catch (caught) {
			// The DB stays the final arbiter for slug / category races (§9.8):
			// translate its constraint codes into form errors instead of a 500.
			const code = pgErrorCode(caught);
			if (code === '23505') {
				return fail(400, {
					errors: { ...errors, slug: '该 Slug 已被其他文章使用' },
					values
				});
			}
			if (code === '23503') {
				return fail(400, { errors: { ...errors, categoryId: '分类不存在' }, values });
			}
			throw caught;
		}

		throw redirect(303, `/admin/posts/edit?id=${postId}&saved=1`);
	}
} satisfies Actions;
