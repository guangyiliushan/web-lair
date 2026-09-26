import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, postTags, posts, tags } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import {
	createTranslationDraft,
	discardDraft,
	isPlaceholderSlug,
	loadDraftByPostId,
	publishDraft,
	saveDraftWork
} from '$lib/server/services/post-drafts';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';

/**
 * P2 editor (ledger §9.2/§9.10): the post row is the published version and is
 * only written by the publish transaction; all editing goes through a single
 * `drafts` row per target. Autosave and the manual save share one action -
 * the client only differs in the throttle flag.
 */

async function loadTagNames(postId: string): Promise<string[]> {
	const rows = await db
		.select({ name: tags.name })
		.from(postTags)
		.innerJoin(tags, eq(postTags.tagId, tags.id))
		.where(eq(postTags.postId, postId))
		.orderBy(tags.name);
	return rows.map((r) => r.name);
}

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	const [allCategories, defaultLang] = await Promise.all([
		db
			.select({ id: categories.id, name: categories.name, slug: categories.slug })
			.from(categories)
			.orderBy(categories.name),
		getOption('site.default_lang')
	]);
	const langs: string[] = [...OPTION_LANGS];

	// ?id= loads an existing post; without it this page creates a new article.
	const id = url.searchParams.get('id');
	if (id && !isUuid(id)) error(404, '文章不存在');

	let post = null;
	let draft = null;
	let source = null;
	let siblings: { id: string; lang: string; status: string }[] = [];

	if (id) {
		const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
		if (!row) error(404, '文章不存在');
		const tagNames = await loadTagNames(row.id);
		post = {
			id: row.id,
			title: row.title,
			slug: row.slug,
			categoryId: row.categoryId,
			summary: row.summary,
			content: row.content,
			status: row.status,
			lang: row.lang,
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			tags: tagNames.join(','),
			placeholder: isPlaceholderSlug(row.slug),
			translatedFromPostId: row.translatedFromPostId
		};

		const draftRow = await loadDraftByPostId(row.id);
		if (draftRow) {
			draft = {
				id: draftRow.id,
				version: draftRow.version,
				title: draftRow.title,
				slug: draftRow.slug,
				categoryId: draftRow.categoryId,
				summary: draftRow.summary,
				content: draftRow.content,
				tags: (draftRow.tags ?? []).join(','),
				updatedAt: draftRow.updatedAt
			};
		}

		if (row.translatedFromPostId) {
			const [sourceRow] = await db
				.select({ id: posts.id, title: posts.title, slug: posts.slug, lang: posts.lang })
				.from(posts)
				.where(eq(posts.id, row.translatedFromPostId))
				.limit(1);
			source = sourceRow ?? null;
		}

		siblings = await db
			.select({ id: posts.id, lang: posts.lang, status: posts.status })
			.from(posts)
			.where(and(eq(posts.translationGroup, row.translationGroup), ne(posts.id, row.id)));
	}

	return {
		headerTitle: '博文',
		headerActions: [
			{ label: '返回', iconName: 'arrow-left', variant: 'outline', href: '/admin/posts' }
		],
		categories: allCategories,
		langs,
		defaultLang,
		post,
		draft,
		source,
		siblings,
		aiAvailable: false
	};
};

export const actions: Actions = {
	/**
	 * Autosave (`autosave=1`) and the manual "保存草稿" share this action.
	 * Returns `{ saved }` payloads; conflicts answer 409 so the client can
	 * refuse to overwrite (§9.10).
	 */
	save: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const rawId = str(form, 'id').trim();
		const draftId = str(form, 'draftId').trim();
		const versionRaw = str(form, 'draftVersion').trim();
		const langRaw = str(form, 'lang').trim();
		const autosave = form.get('autosave') === '1';
		if (rawId && !isUuid(rawId)) return fail(400, { message: '文章标识无效' });
		if (draftId && !isUuid(draftId)) return fail(400, { message: '草稿标识无效' });
		// Malformed category ids must never reach the uuid column (22P02 → 500;
		// the P1.1 guard this rewrite had dropped - review finding).
		const categoryIdRaw = str(form, 'categoryId').trim();
		if (categoryIdRaw && !isUuid(categoryIdRaw)) {
			return fail(400, { message: '分类标识无效' });
		}

		const result = await saveDraftWork({
			draftId: draftId || null,
			postId: rawId || null,
			// A non-numeric version is treated as "not provided" (Number('abc') is
			// NaN, which used to make every save a permanent 409; review finding).
			expectedVersion: /^\d+$/.test(versionRaw) ? Number(versionRaw) : null,
			lang: (OPTION_LANGS as readonly string[]).includes(langRaw) ? langRaw : null,
			payload: {
				title: str(form, 'title'),
				slug: str(form, 'slug').trim().toLowerCase(),
				categoryId: categoryIdRaw,
				summary: str(form, 'summary'),
				tags: str(form, 'tags'),
				content: str(form, 'content')
			},
			author: locals.admin?.userId ?? locals.user?.id ?? null,
			autosave
		});

		switch (result.kind) {
			case 'saved':
				return {
					saved: true,
					draftId: result.draftId,
					draftVersion: result.version,
					postId: result.postId || null,
					updatedAt: result.updatedAt
				};
			case 'unchanged':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					postId: result.postId || null
				};
			case 'throttled':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					postId: result.postId || null,
					// The client schedules its retry from this hint.
					retryAfterMs: result.retryAfterMs
				};
			case 'needs-category':
				return fail(400, { message: '请先选择分类，选定后即可自动保存', needsCategory: true });
			case 'not-found':
				return fail(404, { message: '文章不存在' });
			case 'conflict':
				return fail(409, {
					conflict: true,
					server: result.server,
					message: '内容已在其他窗口更新，请以服务端为准刷新后再编辑'
				});
		}
	},

	/** Publish transaction: copy draft → posts + revision + tags + trackers. */
	publish: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId)) return fail(400, { message: '草稿标识无效' });

		const result = await publishDraft(draftId, locals.admin?.userId ?? locals.user?.id ?? null);
		switch (result.kind) {
			case 'published':
				throw redirect(303, `/admin/posts/edit?id=${result.postId}&published=1`);
			case 'invalid':
				return fail(400, { errors: result.errors, message: '发布校验未通过' });
			case 'conflict':
				return fail(409, {
					conflict: true,
					message: '文章基底已更新（可能在其他窗口发布过），请刷新后重试',
					server: result.server
				});
			case 'slug-taken':
				return fail(400, { errors: { slug: '该 Slug 已被其他文章使用' } });
			case 'busy':
				return fail(409, { message: '并发操作冲突，请稍后重试' });
			case 'not-found':
				return fail(404, { message: '草稿不存在' });
		}
	},

	/**
	 * Explicit discard (§9.14.3): drop the working copy; a never-published
	 * placeholder posts row goes with it.
	 */
	discard: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId)) return fail(400, { message: '草稿标识无效' });

		const result = await discardDraft(draftId);
		if (result.kind === 'not-found') return fail(404, { message: '草稿不存在' });
		if (result.kind === 'busy') return fail(409, { message: '并发操作冲突，请稍后重试' });
		if (result.removedPlaceholder) throw redirect(303, '/admin/posts?discarded=1');
		if (result.postId) throw redirect(303, `/admin/posts/edit?id=${result.postId}&discarded=1`);
		throw redirect(303, '/admin/posts?discarded=1');
	},

	/** Manual copy-prefill path for translations (§9.20.4). */
	createTranslation: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const sourceId = str(form, 'id').trim();
		const lang = str(form, 'lang').trim();
		if (!sourceId || !isUuid(sourceId)) return fail(400, { message: '文章标识无效' });
		if (!(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, { message: '请选择目标语言' });
		}

		const result = await createTranslationDraft(
			sourceId,
			lang,
			locals.admin?.userId ?? locals.user?.id ?? null
		);
		switch (result.kind) {
			case 'created':
				throw redirect(303, `/admin/posts/edit?id=${result.postId}&translation=1`);
			case 'same-lang':
				return fail(400, { message: '不能为同语言创建翻译' });
			case 'lang-exists':
				return fail(400, { message: '该语言版本已存在' });
			case 'not-source':
				return fail(400, { message: '请从源语言版本创建翻译' });
			case 'not-found':
				return fail(404, { message: '文章不存在' });
		}
	}
} satisfies Actions;
