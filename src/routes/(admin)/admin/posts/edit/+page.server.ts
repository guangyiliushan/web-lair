import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, postTags, posts, tags } from '$lib/server/db/content';
import { parseTags, validatePostForm } from '$lib/server/services/posts';
import type { PageServerLoad, Actions } from './$types';

/** The editor still speaks a publish boolean; P1 maps it onto the status machine. */
const DEFAULT_LANG = 'en';

async function loadTagNames(postId: string): Promise<string[]> {
	const rows = await db
		.select({ name: tags.name })
		.from(postTags)
		.innerJoin(tags, eq(postTags.tagId, tags.id))
		.where(eq(postTags.postId, postId))
		.orderBy(tags.name);
	return rows.map((r) => r.name);
}

async function syncPostTags(postId: string, names: string[]) {
	await db.delete(postTags).where(eq(postTags.postId, postId));
	for (const name of names) {
		const slug = name.toLowerCase().replace(/\s+/g, '-');
		const [tag] = await db
			.insert(tags)
			.values({ name, slug })
			.onConflictDoUpdate({ target: tags.slug, set: { name } })
			.returning({ id: tags.id });
		await db.insert(postTags).values({ postId, tagId: tag.id }).onConflictDoNothing();
	}
}

export const load: PageServerLoad = async ({ url }) => {
	const allCategories = await db
		.select({ id: categories.id, name: categories.name, slug: categories.slug })
		.from(categories)
		.orderBy(categories.name);

	// ?id= loads an existing post for editing; without it this page creates a new post.
	const id = url.searchParams.get('id');
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
		const id = formData.get('id')?.toString().trim();
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

		const errors = validatePostForm(values);
		if (Object.keys(errors).length > 0) {
			return fail(400, { errors, values });
		}

		// Slug uniqueness inside the default language (P2 adds the language
		// picker), excluding the post itself on update.
		const slugOwner = await db.query.posts.findFirst({
			where: id
				? and(eq(posts.lang, DEFAULT_LANG), eq(posts.slug, values.slug), ne(posts.id, id))
				: and(eq(posts.lang, DEFAULT_LANG), eq(posts.slug, values.slug)),
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
		if (id) {
			const updated = await db
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
					...(values.isPublished ? { publishedAt: sql`coalesce(${posts.publishedAt}, now())` } : {})
				})
				.where(eq(posts.id, id))
				.returning({ id: posts.id });
			if (updated.length === 0) error(404, '文章不存在');
			postId = updated[0].id;
		} else {
			const [created] = await db
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
			postId = created.id;
		}

		await syncPostTags(postId, tagNames);

		throw redirect(303, `/admin/posts/edit?id=${postId}&saved=1`);
	}
} satisfies Actions;
