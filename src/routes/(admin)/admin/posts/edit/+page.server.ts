import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, postTags, posts, tags } from '$lib/server/db/content';
import {
	normalizeProvenance,
	postProvenanceFromPayload
} from '$lib/server/db/content/post-provenance';
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
import { m } from '$lib/paraglide/messages';

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
	if (id && !isUuid(id)) error(404, m.admin_posts_edit_err_not_found());

	let post = null;
	let draft = null;
	let source = null;
	let siblings: { id: string; lang: string; status: string }[] = [];

	if (id) {
		const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
		if (!row) error(404, m.admin_posts_edit_err_not_found());
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
			translatedFromPostId: row.translatedFromPostId,
			provenance: {
				writingOrigin: row.writingOrigin,
				visualOrigin: row.visualOrigin,
				aiHelp: row.aiHelp ?? []
			}
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
				updatedAt: draftRow.updatedAt,
				provenance: postProvenanceFromPayload(draftRow.payload)
			};
		}

		if (row.translatedFromPostId) {
			const [sourceRow] = await db
				.select({
					id: posts.id,
					title: posts.title,
					slug: posts.slug,
					lang: posts.lang,
					writingOrigin: posts.writingOrigin,
					visualOrigin: posts.visualOrigin,
					aiHelp: posts.aiHelp
				})
				.from(posts)
				.where(eq(posts.id, row.translatedFromPostId))
				.limit(1);
			source = sourceRow ?? null;
			if (sourceRow && post) {
				// The disabled controls should show what the public page will
				// inherit, not the translation row's empty columns.
				post.provenance = {
					writingOrigin: post.provenance.writingOrigin ?? sourceRow.writingOrigin,
					visualOrigin: post.provenance.visualOrigin ?? sourceRow.visualOrigin,
					aiHelp: post.provenance.aiHelp.length ? post.provenance.aiHelp : (sourceRow.aiHelp ?? [])
				};
			}
		}

		siblings = await db
			.select({ id: posts.id, lang: posts.lang, status: posts.status })
			.from(posts)
			.where(and(eq(posts.translationGroup, row.translationGroup), ne(posts.id, row.id)));
	}

	return {
		headerTitle: m.admin_nav_posts(),
		headerActions: [
			{
				label: m.admin_common_back(),
				iconName: 'arrow-left',
				variant: 'outline',
				href: '/admin/posts'
			}
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
	 * Autosave (`autosave=1`) and the manual "Save draft" share this action.
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
		if (rawId && !isUuid(rawId))
			return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		if (draftId && !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });
		// Malformed category ids must never reach the uuid column (22P02 → 500;
		// the P1.1 guard this rewrite had dropped - review finding).
		const categoryIdRaw = str(form, 'categoryId').trim();
		if (categoryIdRaw && !isUuid(categoryIdRaw)) {
			return fail(400, { message: m.admin_posts_edit_err_bad_category_id() });
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
				content: str(form, 'content'),
				provenance: normalizeProvenance({
					writingOrigin: str(form, 'writingOrigin') || null,
					visualOrigin: str(form, 'visualOrigin') || null,
					aiHelp: str(form, 'aiHelp')
				})
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
				return fail(400, { message: m.admin_posts_edit_pick_category_hint(), needsCategory: true });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_not_found() });
			case 'conflict':
				return fail(409, {
					conflict: true,
					server: result.server,
					message: m.admin_posts_edit_err_conflict_long()
				});
		}
	},

	/** Publish transaction: copy draft → posts + revision + tags + trackers. */
	publish: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });

		const result = await publishDraft(draftId, locals.admin?.userId ?? locals.user?.id ?? null);
		switch (result.kind) {
			case 'published':
				throw redirect(303, `/admin/posts/edit?id=${result.postId}&published=1`);
			case 'invalid':
				return fail(400, {
					errors: result.errors,
					message: m.admin_posts_edit_err_publish_validation()
				});
			case 'conflict':
				return fail(409, {
					conflict: true,
					message: m.admin_posts_edit_err_base_updated(),
					server: result.server
				});
			case 'slug-taken':
				return fail(400, { errors: { slug: m.admin_posts_edit_err_slug_taken() } });
			case 'busy':
				return fail(409, { message: m.admin_posts_edit_err_busy() });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_draft_not_found() });
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
		if (!draftId || !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });

		const result = await discardDraft(draftId);
		if (result.kind === 'not-found')
			return fail(404, { message: m.admin_posts_edit_err_draft_not_found() });
		if (result.kind === 'busy') return fail(409, { message: m.admin_posts_edit_err_busy() });
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
		if (!sourceId || !isUuid(sourceId))
			return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		if (!(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, { message: m.admin_posts_edit_target_lang() });
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
				return fail(400, { message: m.admin_posts_edit_err_same_lang() });
			case 'lang-exists':
				return fail(400, { message: m.admin_posts_edit_err_lang_exists() });
			case 'not-source':
				return fail(400, { message: m.admin_posts_edit_err_from_source() });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_not_found() });
		}
	}
} satisfies Actions;
