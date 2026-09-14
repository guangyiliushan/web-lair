import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { getSnowflake } from '$lib/server/snowflake';
import { parseTags, validatePostForm } from '$lib/server/services/posts';
import type { PageServerLoad, Actions } from './$types';

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
				tags: posts.tags,
				isPublished: posts.isPublished,
				createdAt: posts.createdAt,
				modifiedAt: posts.modifiedAt
			})
			.from(posts)
			.where(eq(posts.id, id))
			.limit(1);
		if (!row) error(404, '文章不存在');
		post = { ...row, tags: row.tags.join(',') };
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

		// Slug uniqueness check, excluding the post itself on update.
		const slugOwner = await db.query.posts.findFirst({
			where: id ? and(eq(posts.slug, values.slug), ne(posts.id, id)) : eq(posts.slug, values.slug),
			columns: { id: true }
		});
		if (slugOwner) {
			return fail(400, {
				errors: { ...errors, slug: '该 Slug 已被其他文章使用' },
				values
			});
		}

		const tags = parseTags(tagsRaw);
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
					tags,
					isPublished: values.isPublished,
					modifiedAt: now
				})
				.where(eq(posts.id, id))
				.returning({ id: posts.id });
			if (updated.length === 0) error(404, '文章不存在');
			postId = updated[0].id;
		} else {
			postId = getSnowflake().nextId().toString();
			await db.insert(posts).values({
				id: postId,
				title: values.title,
				slug: values.slug,
				categoryId: values.categoryId,
				content: values.content,
				contentFormat: 'markdown',
				summary: values.summary || null,
				tags,
				isPublished: values.isPublished,
				createdAt: now,
				modifiedAt: now
			});
		}

		throw redirect(303, `/admin/posts/edit?id=${postId}&saved=1`);
	}
} satisfies Actions;
